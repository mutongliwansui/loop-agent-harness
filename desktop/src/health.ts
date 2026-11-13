/** 健康检查失败：超时，或后端在就绪前就退出了 */
export class HealthTimeoutError extends Error {
  /** 后端日志尾部（由调用方填充，错误窗直接展示） */
  tail: string;
  /** true 表示后端进程已退出而非单纯慢；错误窗据此换一句提示 */
  readonly backendExited: boolean;

  constructor(timeoutMs: number, opts: { tail?: string; backendExited?: boolean } = {}) {
    super(
      opts.backendExited
        ? '后端进程在就绪前已退出'
        : `后端在 ${Math.round(timeoutMs / 1000)}s 内未就绪`,
    );
    this.name = 'HealthTimeoutError';
    this.tail = opts.tail ?? '';
    this.backendExited = opts.backendExited ?? false;
  }
}

/** /health 返回 200 但内容不符：多半是端口被别的服务占了 */
export class HealthMismatchError extends Error {
  readonly port: number;

  constructor(port: number, detail: string) {
    super(`端口 ${port} 上的服务不是 LoopAgent 后端（${detail}）`);
    this.name = 'HealthMismatchError';
    this.port = port;
  }
}

export interface WaitHealthOpts {
  port: number;
  host?: string;
  /** 默认 60s */
  timeoutMs?: number;
  /** 默认 200ms */
  intervalMs?: number;
  /** 后端提前退出时用它主动中断等待 */
  isAlive?: () => boolean;
  /** 单次请求超时，默认 3000ms（避免 TCP 半开把轮询拖死） */
  requestTimeoutMs?: number;
}

interface HealthBody {
  status?: unknown;
  version?: unknown;
}

type ProbeResult = 'ok' | 'mismatch' | 'down';

/** 单次探活：200 且 status==='ok' 才算就绪 */
async function probeOnce(port: number, host: string, timeoutMs: number): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: ac.signal });
    if (res.status !== 200) return 'down';
    const body = (await res.json()) as HealthBody;
    // 校验返回体：端口可能被别的服务占了，而它恰好也返回 200
    return body?.status === 'ok' ? 'ok' : 'mismatch';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 轮询 /health 直到就绪（D1-4）。
 *
 * 不用固定 sleep：实测 SEA 从 spawn 到 /health 返回 200 约 2.5s，
 * 但机器负载不同会有波动，固定等待要么浪费时间要么不够。
 */
export async function waitForHealth(opts: WaitHealthOpts): Promise<void> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 200;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 3_000;
  const started = Date.now();
  let mismatched = 0;

  for (;;) {
    // 后端已退出就不必等到超时：立刻失败，让错误窗尽快拿到日志尾部
    if (opts.isAlive && !opts.isAlive()) {
      throw new HealthTimeoutError(timeoutMs, { backendExited: true });
    }

    const result = await probeOnce(port, host, requestTimeoutMs);
    if (result === 'ok') return;
    if (result === 'mismatch') mismatched += 1;

    if (Date.now() - started >= timeoutMs) {
      // 有响应但内容不对 → 按「端口被别的服务占了」报，比单纯超时更能指向原因
      if (mismatched > 0) {
        throw new HealthMismatchError(port, `/health 返回体缺少 status:"ok"（命中 ${mismatched} 次）`);
      }
      throw new HealthTimeoutError(timeoutMs);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
