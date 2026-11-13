import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import { isPortFree, pickPort, PortUnavailableError } from '../desktop/src/port';

/**
 * 端口探测（D1-3）单测。
 *
 * 用真实 listen 占位来构造「已占用」场景：本模块就是用真实绑定判断可监听性，
 * mock 掉 net 反而测不到真实语义。
 */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function release(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 取一批大概率空闲的高位端口，避开 3000 附近可能被开发服务占用 */
function pickBasePort(): number {
  return 34100 + Math.floor(Math.random() * 400);
}

describe('isPortFree', () => {
  it('空闲端口返回 true', async () => {
    const base = pickBasePort();
    await expect(isPortFree(base)).resolves.toBe(true);
  });

  it('已占用端口返回 false', async () => {
    const base = pickBasePort();
    const server = await occupy(base);
    try {
      await expect(isPortFree(base)).resolves.toBe(false);
    } finally {
      await release(server);
    }
  });
});

describe('pickPort', () => {
  it('首选端口空闲时直接返回它', async () => {
    const base = pickBasePort();
    await expect(pickPort(base)).resolves.toBe(base);
  });

  it('首选被占时顺延到下一个空闲端口', async () => {
    const base = pickBasePort();
    const server = await occupy(base);
    try {
      const picked = await pickPort(base);
      expect(picked).not.toBe(base);
      expect(picked).toBe(base + 1);
    } finally {
      await release(server);
    }
  });

  it('连续多个被占时继续顺延', async () => {
    const base = pickBasePort();
    const servers = [await occupy(base), await occupy(base + 1)];
    try {
      const picked = await pickPort(base);
      expect(picked).toBe(base + 2);
    } finally {
      await Promise.all(servers.map(release));
    }
  });

  it('尝试次数用尽时抛 PortUnavailableError，并带上已尝试端口', async () => {
    const base = pickBasePort();
    const servers: Server[] = [];
    try {
      for (let i = 0; i < 3; i += 1) servers.push(await occupy(base + i));
      let caught: unknown;
      try {
        await pickPort(base, { maxTries: 3 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PortUnavailableError);
      expect((caught as PortUnavailableError).tried).toEqual([base, base + 1, base + 2]);
    } finally {
      await Promise.all(servers.map(release));
    }
  });
});
