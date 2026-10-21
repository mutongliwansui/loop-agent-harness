// tab-sync 单测（Task-20261021-002-07 6.2.7）：BroadcastChannel mock 与 localStorage 降级两通道
// node 环境（jsdom 未安装）：globalThis.BroadcastChannel 可控替换；window/localStorage 用最小 stub
// （与 webui-chat-stream-abort.test.ts 同套路：先 stub 再动态导入被测模块）

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type MsgHandler = (e: { data: unknown }) => void;

/** 可编程的 BroadcastChannel 替身：模拟同源多页互斥投递（不回环发送者） */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  name: string;
  onmessage: MsgHandler | null = null;
  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown): void {
    // 广播给「其它」实例（不含自身），复刻 BroadcastChannel 语义
    for (const inst of FakeBroadcastChannel.instances) {
      if (inst !== this) inst.onmessage?.({ data });
    }
  }
  close(): void {}
}

/** 最小 window stub：localStorage（Map 实现）+ storage 监听捕获 */
function makeFakeWindow() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const ls = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
    removeItem: (k: string): void => void store.delete(k),
    keys: (): string[] => [...store.keys()],
    clear: (): void => store.clear(),
  };
  return {
    localStorage: ls,
    addEventListener: (type: string, fn: (e: unknown) => void): void => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void): void => {
      listeners.get(type)?.delete(fn);
    },
    /** 触发 storage 监听（模拟其它标签页写入） */
    fireStorage(key: string, newValue: string | null): void {
      for (const fn of listeners.get('storage') ?? []) fn({ key, newValue });
    },
    get listenerCount(): number {
      return listeners.get('storage')?.size ?? 0;
    },
  };
}

type FakeWindow = ReturnType<typeof makeFakeWindow>;

const savedBC = globalThis.BroadcastChannel;

let fakeWin: FakeWindow;

describe('tab-sync', () => {
  beforeEach(() => {
    vi.resetModules(); // tab-sync 的通道在模块加载时确定，每个用例重新加载
    FakeBroadcastChannel.instances = [];
    fakeWin = makeFakeWindow();
    vi.stubGlobal('window', fakeWin);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedBC === undefined) {
      // @ts-expect-error 测试环境还原
      delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    } else {
      globalThis.BroadcastChannel = savedBC;
    }
  });

  it('BroadcastChannel 可用：postTab 经通道投递且不回环到本页订阅者', async () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
    const mod = await import('../webui/src/tab-sync.js');
    const received: unknown[] = [];
    const off = mod.onTab((m) => received.push(m));
    mod.postTab({ t: 'run-started', id: 's1' });
    // 本页订阅者不应收到自己发的消息（通道不回环）
    expect(received).toHaveLength(0);
    expect(FakeBroadcastChannel.instances[0]?.name).toBe('loop-agent');
    off();
  });

  it('跨实例投递：A 实例 post → B 实例的订阅者收到完整消息', async () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
    const mod = await import('../webui/src/tab-sync.js');
    const received: unknown[] = [];
    mod.onTab((m) => received.push(m));
    // 模拟另一个标签页的通道实例（post 会被 FakeChannel 转给本页订阅者）
    const pageB = new FakeBroadcastChannel('loop-agent');
    pageB.postMessage({ t: 'run-finished', id: 's2', status: 'done', at: 123 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ t: 'run-finished', id: 's2', status: 'done', at: 123 });
  });

  it('无 BroadcastChannel：降级 localStorage，storage 事件触发接收', async () => {
    // @ts-expect-error 显式置空模拟旧浏览器
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const mod = await import('../webui/src/tab-sync.js');
    const received: unknown[] = [];
    mod.onTab((m) => received.push(m));
    mod.postTab({ t: 'unread-cleared', id: 's3' });
    // postTab 写入了 localStorage 随机键（__la_tab__ 前缀）
    const keys = fakeWin.localStorage.keys().filter((k) => k.startsWith('__la_tab__'));
    expect(keys).toHaveLength(1);
    // 模拟「其它标签页」写入并触发 storage 事件：他页随机键必然 ≠ 本页 lastWrittenKey
    const msg = JSON.stringify({ t: 'unread-cleared', id: 's3', at: Date.now() });
    fakeWin.localStorage.setItem('__la_tab__other1', msg);
    fakeWin.fireStorage('__la_tab__other1', msg);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ t: 'unread-cleared', id: 's3' });
  });

  it('降级通道：写入后 500ms 自动清理随机键', async () => {
    vi.useFakeTimers();
    try {
      // @ts-expect-error 显式置空模拟旧浏览器
      (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
      const mod = await import('../webui/src/tab-sync.js');
      mod.onTab(() => {});
      mod.postTab({ t: 'session-dropped', id: 's4a' });
      expect(fakeWin.localStorage.keys().some((k) => k.startsWith('__la_tab__'))).toBe(true);
      vi.advanceTimersByTime(600);
      expect(fakeWin.localStorage.keys().some((k) => k.startsWith('__la_tab__'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('降级通道：自身键的 storage 事件被排除（lastWrittenKey 防自收）', async () => {
    // @ts-expect-error 显式置空模拟旧浏览器
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const mod = await import('../webui/src/tab-sync.js');
    const received: unknown[] = [];
    mod.onTab((m) => received.push(m));
    mod.postTab({ t: 'session-dropped', id: 's4' });
    const keys = fakeWin.localStorage.keys().filter((k) => k.startsWith('__la_tab__'));
    const raw = fakeWin.localStorage.getItem(keys[0]) ?? '';
    // 某些浏览器自身写入也触发 storage：此时按 lastWrittenKey 排除
    fakeWin.fireStorage(keys[0], raw);
    expect(received).toHaveLength(0);
  });

  it('降级通道：at 去重窗口内重复投递只收一次', async () => {
    // @ts-expect-error 显式置空模拟旧浏览器
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const mod = await import('../webui/src/tab-sync.js');
    const received: unknown[] = [];
    mod.onTab((m) => received.push(m));
    // 同一条消息两次 storage 事件（不同随机键、同内容）：按 t:id:at 去重
    const msg = JSON.stringify({ t: 'run-started', id: 's5', at: 42 });
    fakeWin.localStorage.setItem('__la_tab__k1', msg);
    fakeWin.localStorage.setItem('__la_tab__k2', msg);
    fakeWin.fireStorage('__la_tab__k1', msg);
    fakeWin.fireStorage('__la_tab__k2', msg);
    expect(received).toHaveLength(1);
  });

  it('反注册后不再接收，storage 监听同步移除', async () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
    const mod = await import('../webui/src/tab-sync.js');
    const received: unknown[] = [];
    const off = mod.onTab((m) => received.push(m));
    expect(fakeWin.listenerCount).toBe(0); // 主通道：无 storage 监听
    off();
    const pageB = new FakeBroadcastChannel('loop-agent');
    pageB.postMessage({ t: 'run-started', id: 's6', at: 1 });
    expect(received).toHaveLength(0);
  });

  it('反注册（降级通道）后 storage 监听被移除', async () => {
    // @ts-expect-error 显式置空模拟旧浏览器
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const mod = await import('../webui/src/tab-sync.js');
    const off = mod.onTab(() => {});
    expect(fakeWin.listenerCount).toBe(1);
    off();
    expect(fakeWin.listenerCount).toBe(0);
  });

  it('畸形消息（缺字段/非 JSON）静默忽略不抛错', async () => {
    // @ts-expect-error 显式置空模拟旧浏览器
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const mod = await import('../webui/src/tab-sync.js');
    const received: unknown[] = [];
    mod.onTab((m) => received.push(m));
    fakeWin.fireStorage('__la_tab__bad', '{not json');
    fakeWin.fireStorage('__la_tab__bad2', '{"x":1}');
    expect(received).toHaveLength(0);
  });
});
