import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { pickPort } from '../desktop/src/port';
import { waitForHealth, HealthTimeoutError, HealthMismatchError } from '../desktop/src/health';

/**
 * 健康探针（D1-4/D1-6）单测。
 *
 * 用本地 http server 模拟后端的 /health，覆盖：正常就绪、启动慢、
 * 端口被非 LoopAgent 服务占用、一直不可用、后端提前退出五类分支。
 */
const FAST = { intervalMs: 20, timeoutMs: 1500 };

/** 与真实后端一致的 /health 返回体（status 必须是字符串 'ok'） */
const OK_BODY = JSON.stringify({ status: 'ok', version: '0.0.0-test' });

async function serve(
  handler: (url: string) => { status: number; body: string },
): Promise<{ server: Server; port: number }> {
  const port = await pickPort(34100 + Math.floor(Math.random() * 400));
  const server = createServer((req, res) => {
    const r = handler(req.url ?? '/');
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('waitForHealth：就绪', () => {
  it('/health 返回 status:"ok" 时 resolve', async () => {
    const { server, port } = await serve(() => ({ status: 200, body: OK_BODY }));
    try {
      await expect(waitForHealth({ port, ...FAST })).resolves.toBeUndefined();
    } finally {
      await close(server);
    }
  });

  it('先不就绪后不就绪，最终就绪（模拟后端启动慢）', async () => {
    let hits = 0;
    const { server, port } = await serve(() => {
      hits += 1;
      // 前两次返回 503，模拟服务已监听但尚未就绪
      return hits <= 2 ? { status: 503, body: '{"status":"starting"}' } : { status: 200, body: OK_BODY };
    });
    try {
      await expect(waitForHealth({ port, ...FAST })).resolves.toBeUndefined();
      expect(hits).toBeGreaterThanOrEqual(3);
    } finally {
      await close(server);
    }
  });
});

describe('waitForHealth：失败', () => {
  it('一直不可用时超时并抛 HealthTimeoutError', async () => {
    const { server, port } = await serve(() => ({ status: 500, body: '{}' }));
    try {
      const err = await waitForHealth({ port, intervalMs: 10, timeoutMs: 300 }).catch((e) => e);
      expect(err).toBeInstanceOf(HealthTimeoutError);
      expect(err.backendExited).toBe(false);
    } finally {
      await close(server);
    }
  });

  it('端口被其他服务占用（200 但内容不符）时抛 HealthMismatchError', async () => {
    // 这是 D1-5 想防的情况：端口探测通过，但上面跑的不是自家后端
    const { server, port } = await serve(() => ({ status: 200, body: '{"hello":"not-loop-agent"}' }));
    try {
      const err = await waitForHealth({ port, intervalMs: 10, timeoutMs: 300 }).catch((e) => e);
      expect(err).toBeInstanceOf(HealthMismatchError);
      expect(err.port).toBe(port);
    } finally {
      await close(server);
    }
  });

  it('后端提前退出时立即失败，不等满 timeout（D1-6）', async () => {
    const port = await pickPort(34100 + Math.floor(Math.random() * 400));
    let aliveCalls = 0;
    const startedAt = Date.now();
    let caught: unknown;
    try {
      await waitForHealth({
        port,
        // 第 3 次轮询起判定后端已退出（前两次还在启动窗口内）
        isAlive: () => {
          aliveCalls += 1;
          return aliveCalls <= 2;
        },
        intervalMs: 20,
        timeoutMs: 10_000,
      });
    } catch (err) {
      caught = err;
    }
    // 远小于 10s，说明是被 isAlive 中断而非等满超时
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(caught).toBeInstanceOf(HealthTimeoutError);
    expect((caught as HealthTimeoutError).backendExited).toBe(true);
    // 提前退出时不该把「已退出」当日志尾部塞给错误窗
    expect((caught as HealthTimeoutError).tail).toBe('');
  });
});
