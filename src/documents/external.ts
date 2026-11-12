// 可选外部 PDF 工具兜底（需求 20261112-001 / 任务 03）
// 仅在「内置解析判定扫描件或疑似乱码」时尝试系统 pdftotext；不存在/失败均静默回退。
// 安全：spawn 参数数组、无 shell、固定参数、超时与输出上限。

import { spawn, spawnSync } from 'node:child_process';

/** pdftotext 可用性缓存（进程内只探测一次） */
let cachedAvailable: boolean | null = null;

export function pdftotextAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    const r = spawnSync('pdftotext', ['-v'], { timeout: 2000, stdio: 'ignore' });
    // pdftotext -v 在多数版本返回 1，但能正常启动即视为可用
    cachedAvailable = r.error == null && (r.status === 0 || r.status === 1);
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/** 测试钩子：重置可用性缓存 */
export function resetPdftotextCacheForTest(): void {
  cachedAvailable = null;
}

const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;

/** 调用 pdftotext 提取文本；失败/超时/空输出返回 null */
export function runPdftotext(absPath: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let bytes = 0;
    let child: ReturnType<typeof spawn> | null = null;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        // 已退出
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), Math.max(1000, timeoutMs));
    timer.unref?.();

    try {
      child = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', absPath, '-'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish(null);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(null);
        return;
      }
      out += chunk.toString('utf-8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      finish(code === 0 && out.trim() ? out : null);
    });
  });
}
