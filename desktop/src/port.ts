import { createServer } from 'node:net';

/** 端口不可用时抛出，携带已尝试端口列表供错误窗展示 */
export class PortUnavailableError extends Error {
  readonly tried: number[];

  constructor(tried: number[]) {
    super(`端口全部被占用（已尝试 ${tried.join(', ')}）`);
    this.name = 'PortUnavailableError';
    this.tried = tried;
  }
}

/**
 * 判断端口是否可监听。
 *
 * 用真实 listen 试探而不是连接探测：只有真正绑上才能确认可监听，
 * 也顺带覆盖「端口被别的进程占用但拒绝连接」这类情况。
 */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export interface PickPortOpts {
  /** 最多顺延尝试多少个端口（含首选），默认 21 → 3000..3020 */
  maxTries?: number;
}

/**
 * 从首选端口起顺延选一个空闲端口（D1-3）。
 *
 * 不使用 `--port 0`：后端 parsePort 只接受 1..65535，0 会被静默丢弃并回落配置端口
 * （cli-overrides.ts:30-35），因此端口必须由壳先探明再传具体值。
 */
export async function pickPort(preferred: number, opts: PickPortOpts = {}): Promise<number> {
  const maxTries = opts.maxTries ?? 21;
  const tried: number[] = [];

  for (let i = 0; i < maxTries; i += 1) {
    // 超过上限后回绕到合法范围低位继续找，避免首选端口接近 65535 时一个都试不到
    const port = ((preferred - 1 + i) % 65535) + 1;
    tried.push(port);
    if (await isPortFree(port)) return port;
  }

  throw new PortUnavailableError(tried);
}
