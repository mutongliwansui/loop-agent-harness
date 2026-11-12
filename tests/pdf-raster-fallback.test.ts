// PDF 光栅化探测顺序与逐级回落单测（需求 20261112-004 / 任务 01 / P0）
//
// 覆盖 D2（custom → winrt → 外部工具）与 D8（内建引擎级不可用回落外部工具、页级失败不回落）。
// 两侧依赖都打桩：真实渲染要 WinRT，真实外部工具要 pdftoppm —— 都不进单测。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** 内建渲染器「本机是否可用」 */
  winrtAvailable: true,
  /** renderPdfPageWinrt 的固定返回（null = 成功并写文件） */
  winrtResult: null as null | { ok: boolean; engineUnavailable: boolean; error?: string },
  /** renderPdfPageWinrt 调用记录 */
  winrtCalls: [] as { input: string; page: number; dpi?: number; timeoutMs?: number }[],
  /** 外部工具探测：命令名 → 是否可用 */
  tools: { pdftoppm: true, mutool: false, gs: false } as Record<string, boolean>,
  /** 外部工具执行记录 */
  spawnLog: [] as { cmd: string; args: string[] }[],
  /** 让某些外部命令执行失败 */
  failCmds: new Set<string>(),
}));

vi.mock('../src/documents/pdf-raster-winrt.js', async () => {
  const fs = await import('node:fs');
  return {
    WINRT_PDF_PS1: '# mocked',
    WINRT_PDF_DPI: 150,
    WINRT_PDF_TIMEOUT_MS: 15000,
    winrtPdfLikelyAvailable: () => state.winrtAvailable,
    renderPdfPageWinrt: async (req: {
      input: string;
      page: number;
      output: string;
      dpi?: number;
      timeoutMs?: number;
    }) => {
      state.winrtCalls.push(req);
      if (state.winrtResult) {
        return { elapsedMs: 1, exitCode: state.winrtResult.ok ? 0 : 3, ...state.winrtResult };
      }
      fs.writeFileSync(req.output, 'PNGDATA');
      return { ok: true, engineUnavailable: false, exitCode: 0, elapsedMs: 1 };
    },
  };
});

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const fs = await import('node:fs');
  return {
    // 探测判定是「spawnSync 未抛错即视为可启动」（-v 退出码常非 0），故不可用要返回 error
    spawnSync: (cmd: string) => (state.tools[cmd] ? { status: 0 } : { error: new Error('ENOENT') }),
    spawn: (cmd: string, args: string[]) => {
      const child = new EventEmitter() as unknown as {
        on: (ev: string, fn: (...a: unknown[]) => void) => void;
        kill: () => void;
      };
      child.kill = () => undefined;
      state.spawnLog.push({ cmd, args });
      setImmediate(() => {
        if (state.failCmds.has(cmd)) {
          (child as unknown as EventEmitter).emit('close', 1);
          return;
        }
        const raw = [...args].reverse().find((a) => a.includes('.png'));
        if (raw) {
          const out = raw.startsWith('-sOutputFile=') ? raw.slice('-sOutputFile='.length) : raw;
          fs.writeFileSync(out, 'PNGDATA');
        }
        (child as unknown as EventEmitter).emit('close', 0);
      });
      return child;
    },
  };
});

const { RASTERIZER_HINT, rasterizePdfPages, resetRasterizerProbeCache } = await import(
  '../src/documents/pdf-raster.js'
);

beforeEach(() => {
  state.winrtAvailable = true;
  state.winrtResult = null;
  state.winrtCalls = [];
  state.tools = { pdftoppm: true, mutool: false, gs: false };
  state.spawnLog = [];
  state.failCmds = new Set();
  resetRasterizerProbeCache();
});

describe('探测顺序（D2）', () => {
  it('自定义模板优先级最高，且不触发内建渲染与外部探测', async () => {
    const r = await rasterizePdfPages('D:\\doc.pdf', [1], {
      customTemplate: 'mytool --in {input} --page {page} --out {output}',
    });
    expect(r.tool).toBe('custom');
    expect(r.pages.map((p) => p.page)).toEqual([1]);
    expect(state.winrtCalls).toHaveLength(0);
    expect(state.spawnLog[0].cmd).toBe('mytool');
  });

  it('auto 模式下内建渲染器优先于外部工具', async () => {
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1, 2]);
    expect(r.tool).toBe('winrt');
    expect(state.winrtCalls).toHaveLength(2);
    expect(state.spawnLog).toHaveLength(0);
    expect(r.warnings).toEqual([]);
  });

  it('engine=external 时完全不碰内建渲染器', async () => {
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1], { engine: 'external' });
    expect(r.tool).toBe('pdftoppm');
    expect(state.winrtCalls).toHaveLength(0);
    expect(state.spawnLog.map((s) => s.cmd)).toContain('pdftoppm');
  });

  it('engine=winrt 且内建不可用时不回落，直接给安装指引', async () => {
    state.winrtAvailable = false;
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1], { engine: 'winrt' });
    expect(r.pages).toEqual([]);
    expect(r.tool).toBeNull();
    expect(r.warnings).toContain(RASTERIZER_HINT);
    expect(state.spawnLog).toHaveLength(0);
  });

  it('外置工具全缺失且内建不可用 → 空结果 + 安装指引', async () => {
    state.winrtAvailable = false;
    state.tools = { pdftoppm: false, mutool: false, gs: false };
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1]);
    expect(r.pages).toEqual([]);
    expect(r.tool).toBeNull();
    expect(r.warnings).toContain(RASTERIZER_HINT);
  });
});

describe('逐级回落（D8）', () => {
  it('内建渲染器报引擎不可用 → 整体回落外部工具并重试当前页', async () => {
    state.winrtResult = { ok: false, engineUnavailable: true, error: '内建 PDF 渲染不可用（退出码 2）：types_unavailable' };
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1, 2]);
    expect(r.tool).toBe('pdftoppm');
    expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
    // 回落只发生一次：第 2 页不再尝试内建渲染器
    expect(state.winrtCalls.map((c) => c.page)).toEqual([1]);
    expect(state.spawnLog.filter((s) => s.cmd === 'pdftoppm')).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('已回落到 pdftoppm'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('types_unavailable'))).toBe(true);
  });

  it('内建不可用且没有外部工具可回落 → 立即终止剩余页并给指引', async () => {
    state.winrtAvailable = true;
    state.tools = { pdftoppm: false, mutool: false, gs: false };
    state.winrtResult = { ok: false, engineUnavailable: true, error: 'no powershell' };
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1, 2, 3]);
    expect(r.pages).toEqual([]);
    expect(state.winrtCalls).toHaveLength(1);
    expect(r.warnings).toContain(RASTERIZER_HINT);
  });

  it('内建渲染器页级失败不回落，也不影响其余页', async () => {
    let call = 0;
    state.winrtResult = null;
    // 通过替换实现模拟「第 1 页失败、第 2 页成功」
    const mod = await import('../src/documents/pdf-raster-winrt.js');
    const original = mod.renderPdfPageWinrt;
    vi.spyOn(mod, 'renderPdfPageWinrt').mockImplementation(async (req) => {
      call += 1;
      if (call === 1) {
        return { ok: false, engineUnavailable: false, error: 'render_failed', exitCode: 3, elapsedMs: 1 };
      }
      return original(req);
    });
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1, 2]);
    expect(r.tool).toBe('winrt');
    expect(r.pages.map((p) => p.page)).toEqual([2]);
    expect(state.spawnLog).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('第 1 页渲染失败（winrt：render_failed）'))).toBe(true);
  });

  it('外部工具执行失败只影响该页', async () => {
    state.winrtAvailable = false;
    state.failCmds = new Set(['pdftoppm']);
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1, 2], { engine: 'external' });
    expect(r.tool).toBe('pdftoppm');
    expect(r.pages).toEqual([]);
    expect(r.warnings.filter((w) => w.includes('渲染失败'))).toHaveLength(2);
  });
});

describe('预算与参数', () => {
  it('超过 MAX_RASTER_PAGES 时只渲染前 5 页并告警', async () => {
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1, 2, 3, 4, 5, 6, 7]);
    expect(r.pages).toHaveLength(5);
    expect(r.warnings.some((w) => w.includes('仅渲染前 5 页'))).toBe(true);
  });

  it('内建渲染器收到 150 DPI 与配置的超时', async () => {
    await rasterizePdfPages('/tmp/doc.pdf', [3], { timeoutMs: 9000 });
    expect(state.winrtCalls[0].dpi).toBe(150);
    expect(state.winrtCalls[0].page).toBe(3);
    expect(state.winrtCalls[0].timeoutMs).toBe(9000);
  });

  it('已取消时不再渲染后续页', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await rasterizePdfPages('/tmp/doc.pdf', [1, 2], { signal: ac.signal });
    expect(r.pages).toEqual([]);
    expect(state.winrtCalls).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('已取消'))).toBe(true);
  });
});
