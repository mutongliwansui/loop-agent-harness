// PDF 内建渲染器（Windows.Data.Pdf）单测（需求 20261112-004 / 任务 01 / P0）
//
// 只测「脚本内容契约」与「不可用时的返回形态」：真实渲染需要 powershell + WinRT，
// 属「人工验证（真实环境）」清单，不放进单测（避免 CI 依赖 Windows 组件）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WINRT_PDF_DPI,
  WINRT_PDF_PS1,
  WINRT_PDF_TIMEOUT_MS,
  renderPdfPageWinrt,
  winrtPdfLikelyAvailable,
} from '../src/documents/pdf-raster-winrt.js';

describe('WINRT_PDF_PS1 脚本契约', () => {
  it('纯 ASCII 且无 BOM（GBK 代码页机器上必须能正确解读）', () => {
    expect(WINRT_PDF_PS1.charCodeAt(0)).not.toBe(0xfeff);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(WINRT_PDF_PS1)).toBe(true);
  });

  it('用 DIP(96) 换算尺寸，而不是 PDF 的 pt(72)', () => {
    // 这是本任务最容易回归的坑：按 /72 换算会多渲 1.33 倍
    expect(WINRT_PDF_PS1).toContain('/ 96.0 * $Dpi');
    expect(WINRT_PDF_PS1).not.toMatch(/\/\s*72(\.0)?\s*\*/);
  });

  it('PdfPage 只 Dispose，不调不存在的 Close()', () => {
    expect(WINRT_PDF_PS1).toContain('-is [System.IDisposable]');
    expect(WINRT_PDF_PS1).toMatch(/\$pg\.Dispose\(\)/);
    expect(WINRT_PDF_PS1).not.toMatch(/\$pg\.Close\(/);
  });

  it('IAsyncAction 走非泛型 AsTask 重载（泛型无法套用 RenderToStreamAsync）', () => {
    expect(WINRT_PDF_PS1).toContain('IAsyncAction');
    expect(WINRT_PDF_PS1).toContain('IAsyncOperation');
    expect(WINRT_PDF_PS1).toContain('System.WindowsRuntimeSystemExtensions');
  });

  it('WinRT 类型用程序集限定名预热', () => {
    expect(WINRT_PDF_PS1).toContain('ContentType=WindowsRuntime');
    expect(WINRT_PDF_PS1).toContain('Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf');
  });

  it('路径一律 -LiteralPath（中文/空格路径安全）', () => {
    expect(WINRT_PDF_PS1).toContain('Test-Path -LiteralPath $Pdf');
    expect(WINRT_PDF_PS1).toContain('Resolve-Path -LiteralPath $Pdf');
    expect(WINRT_PDF_PS1).toContain('Get-Item -LiteralPath $Out');
  });

  it('退出码区分引擎级(2)与页级(3)失败', () => {
    expect(WINRT_PDF_PS1).toContain('exit 2');
    expect(WINRT_PDF_PS1).toContain('exit 3');
    expect(WINRT_PDF_PS1).toContain('exit 0');
    expect(WINRT_PDF_PS1).toContain('[FAIL]');
  });

  it('宿主闸门：非 Desktop 版 PowerShell 直接判引擎不可用', () => {
    expect(WINRT_PDF_PS1).toContain("$PSVersionTable.PSEdition -ne 'Desktop'");
  });

  it('默认 DPI 与超时导出与脚本默认值一致', () => {
    expect(WINRT_PDF_PS1).toContain(`[double]$Dpi = ${WINRT_PDF_DPI}`);
    expect(WINRT_PDF_TIMEOUT_MS).toBe(15_000);
    expect(WINRT_PDF_DPI).toBe(150);
  });
});

describe('winrtPdfLikelyAvailable / renderPdfPageWinrt', () => {
  const realPlatform = process.platform;
  const realOverride = process.env.LOOP_AGENT_POWERSHELL;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realOverride === undefined) delete process.env.LOOP_AGENT_POWERSHELL;
    else process.env.LOOP_AGENT_POWERSHELL = realOverride;
  });

  it('非 Windows 平台恒判不可用', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(winrtPdfLikelyAvailable()).toBe(false);
  });

  it('非 Windows 平台直接返回引擎不可用，且不 spawn 任何进程', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const r = await renderPdfPageWinrt({
      input: '/tmp/a.pdf',
      page: 1,
      output: '/tmp/a.png',
    });
    expect(r.ok).toBe(false);
    expect(r.engineUnavailable).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain('非 Windows');
  });

  it('Windows 上 powershell.exe 缺失时也判引擎不可用', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.LOOP_AGENT_POWERSHELL = 'C:\\__no_such_dir__\\powershell.exe';
    expect(winrtPdfLikelyAvailable()).toBe(false);
    const r = await renderPdfPageWinrt({
      input: 'C:\\tmp\\a.pdf',
      page: 1,
      output: 'C:\\tmp\\a.png',
    });
    expect(r.ok).toBe(false);
    expect(r.engineUnavailable).toBe(true);
  });
});
