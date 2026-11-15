/**
 * 目录服务：注册/冲突/撤销/排序稳定性/事件。
 *
 * 重点是三条契约级不变量：
 * 1. 重名**不覆盖**（工具名是模型唯一寻址键）；
 * 2. `toToolDefs()` **与注册顺序无关**（前缀缓存）；
 * 3. 批量注册**先全验证后落登记**（无半挂载残留）。
 */

import { describe, expect, it, vi } from 'vitest';

import { EchoTool } from './helpers.js';
import {
  canonicalize,
  createToolRegistry,
  ToolsDuplicateError,
  ToolsInvalidNameError,
  ToolsNotFoundError,
  type ToolRegistry,
} from '../src/index.js';

/** 造一个指定名字与参数 schema 的工具 */
function tool(name: string, parameters: Record<string, unknown> = { type: 'object', properties: {} }) {
  return new EchoTool(name, () => 'ok', parameters);
}

describe('register / get / require', () => {
  it('注册后可取回同一实例', () => {
    const registry = createToolRegistry();
    const t = tool('a');
    registry.register(t);
    expect(registry.get('a')).toBe(t);
    expect(registry.require('a')).toBe(t);
  });

  it('未注册时 get 返回 undefined，require 抛 ToolsNotFoundError', () => {
    const registry = createToolRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(() => registry.require('nope')).toThrow(ToolsNotFoundError);
  });

  it('count / names / list 反映登记状态', () => {
    const registry = createToolRegistry();
    registry.register(tool('a'));
    registry.register(tool('b'));
    expect(registry.count()).toBe(2);
    expect(registry.names()).toEqual(['a', 'b']);
    expect(registry.list().map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('注销函数可重复调用（幂等）', () => {
    const registry = createToolRegistry();
    const dispose = registry.register(tool('a'));
    dispose();
    dispose();
    expect(registry.count()).toBe(0);
  });
});

describe('重名冲突（D11 不覆盖）', () => {
  it('同名注册抛 ToolsDuplicateError，且保留原实例', () => {
    const registry = createToolRegistry();
    const first = tool('dup');
    registry.register(first, { providerId: 'p1' });

    expect(() => registry.register(tool('dup'), { providerId: 'p2' })).toThrow(ToolsDuplicateError);
    // 不覆盖：模型仍调到旧实现
    expect(registry.get('dup')).toBe(first);
  });

  it('错误携带双方 providerId（定位到是谁抢注的）', () => {
    const registry = createToolRegistry();
    registry.register(tool('dup'), { providerId: 'p1' });

    try {
      registry.register(tool('dup'), { providerId: 'p2' });
      throw new Error('应当抛错');
    } catch (err) {
      const e = err as ToolsDuplicateError;
      expect(e.code).toBe('TOOLS_DUPLICATE');
      expect(e.toolName).toBe('dup');
      expect(e.existingProviderId).toBe('p1');
      expect(e.incomingProviderId).toBe('p2');
    }
  });

  it('大小写不同视为不同名（与 MCP/OpenAI 一致）', () => {
    const registry = createToolRegistry();
    registry.register(tool('FileRead'));
    expect(() => registry.register(tool('fileRead'))).not.toThrow();
    expect(registry.count()).toBe(2);
  });

  it('注销后同名可重新注册', () => {
    const registry = createToolRegistry();
    const dispose = registry.register(tool('reusable'));
    dispose();
    expect(() => registry.register(tool('reusable'))).not.toThrow();
  });

  it('旧注销函数不会误删新注册的同名工具', () => {
    const registry = createToolRegistry();
    const disposeOld = registry.register(tool('same'));
    disposeOld();
    const fresh = tool('same');
    registry.register(fresh);
    // 再调一次旧 disposer 不应摘掉新工具
    disposeOld();
    expect(registry.get('same')).toBe(fresh);
  });
});

describe('注册期名字校验（D8）', () => {
  it('非法名字直接抛 ToolsInvalidNameError（同步）', () => {
    const registry = createToolRegistry();
    expect(() => registry.register(tool('my.tool'))).toThrow(ToolsInvalidNameError);
  });

  it('错误含 code 与原因', () => {
    const registry = createToolRegistry();
    try {
      registry.register(tool('x'.repeat(65)));
      throw new Error('应当抛错');
    } catch (err) {
      const e = err as ToolsInvalidNameError;
      expect(e.code).toBe('TOOLS_INVALID_NAME');
      expect(e.reason).toContain('64');
    }
  });

  it('`__` 前缀被拒', () => {
    const registry = createToolRegistry();
    expect(() => registry.register(tool('__mcp__x'))).toThrow(ToolsInvalidNameError);
  });

  it('非法名不进入目录', () => {
    const registry = createToolRegistry();
    expect(() => registry.register(tool('bad name'))).toThrow();
    expect(registry.count()).toBe(0);
  });
});

describe('registerAll：先全验证后落登记', () => {
  it('整批成功时全部登记', () => {
    const registry = createToolRegistry();
    registry.registerAll([tool('a'), tool('b')], { providerId: 'p' });
    expect(registry.names()).toEqual(['a', 'b']);
  });

  it('批内重名 → 抛错且零登记（无半挂载残留）', () => {
    const registry = createToolRegistry();
    expect(() =>
      registry.registerAll([tool('a'), tool('a')], { providerId: 'p' }),
    ).toThrow(ToolsDuplicateError);
    expect(registry.count()).toBe(0);
  });

  it('与目录已有重名 → 抛错且整批不落登记', () => {
    const registry = createToolRegistry();
    registry.register(tool('existing'), { providerId: 'old' });

    expect(() =>
      registry.registerAll([tool('new1'), tool('existing')], { providerId: 'p' }),
    ).toThrow(ToolsDuplicateError);

    // new1 也不该被登记
    expect(registry.get('new1')).toBeUndefined();
    expect(registry.names()).toEqual(['existing']);
  });

  it('批量反注册逆序撤销全部', () => {
    const registry = createToolRegistry();
    const dispose = registry.registerAll([tool('a'), tool('b'), tool('c')]);
    expect(registry.count()).toBe(3);
    dispose();
    expect(registry.count()).toBe(0);
  });

  it('空数组允许（挂载成功但 0 工具）', () => {
    const registry = createToolRegistry();
    const dispose = registry.registerAll([]);
    expect(registry.count()).toBe(0);
    expect(() => dispose()).not.toThrow();
  });
});

describe('listByProvider（诊断归属）', () => {
  it('按提供者过滤', () => {
    const registry = createToolRegistry();
    registry.register(tool('a'), { providerId: 'p1' });
    registry.register(tool('b'), { providerId: 'p2' });
    registry.register(tool('c'), { providerId: 'p1' });

    expect(registry.listByProvider('p1')).toEqual(['a', 'c']);
    expect(registry.listByProvider('p2')).toEqual(['b']);
    expect(registry.listByProvider('unknown')).toEqual([]);
  });
});

describe('toToolDefs：排序与规范化（D12 前缀缓存不变量）', () => {
  it('按 name.localeCompare 升序，与注册顺序无关', () => {
    const r1 = createToolRegistry();
    ['c', 'a', 'b'].forEach((n) => r1.register(tool(n)));

    const r2 = createToolRegistry();
    ['a', 'b', 'c'].forEach((n) => r2.register(tool(n)));

    expect(r1.toToolDefs().map((d) => d.name)).toEqual(['a', 'b', 'c']);
    expect(r1.toToolDefs()).toEqual(r2.toToolDefs());
  });

  it('参数键序不同的等价 schema → 输出逐字节相同', () => {
    const r1 = createToolRegistry();
    r1.register(
      tool('x', { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } }),
    );

    const r2 = createToolRegistry();
    r2.register(
      tool('x', { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' }),
    );

    expect(JSON.stringify(r1.toToolDefs())).toBe(JSON.stringify(r2.toToolDefs()));
  });

  it('输出结构为 { name, description, parameters } 三字段', () => {
    const registry = createToolRegistry();
    registry.register(tool('only'));
    const [def] = registry.toToolDefs();
    expect(Object.keys(def!).sort()).toEqual(['description', 'name', 'parameters']);
  });

  it('parameters 已经过 canonicalize', () => {
    const registry = createToolRegistry();
    const params = { type: 'object', properties: { z: { type: 'string' }, a: { type: 'string' } } };
    registry.register(tool('canon', params));
    const [def] = registry.toToolDefs();
    expect(def!.parameters).toEqual(canonicalize(params));
  });

  it('空目录返回空数组', () => {
    expect(createToolRegistry().toToolDefs()).toEqual([]);
  });

  it('并发注销下的快照遍历不抛错', () => {
    const registry = createToolRegistry();
    const disposers = ['a', 'b', 'c'].map((n) => registry.register(tool(n)));
    // 模拟注册表在遍历期间变化
    const defs = registry.toToolDefs();
    disposers.forEach((d) => d());
    expect(defs).toHaveLength(3);
  });
});

describe('invoke（唯一调用入口）', () => {
  it('转发到工具并按归一语义返回', async () => {
    const registry = createToolRegistry();
    registry.register(new EchoTool('echo', () => '结果'));
    const result = await registry.invoke('echo', {});
    expect(result).toEqual({ text: '结果', isError: false });
  });

  it('未注册的工具 → 抛 ToolsNotFoundError', async () => {
    const registry = createToolRegistry();
    await expect(registry.invoke('missing', {})).rejects.toThrow(ToolsNotFoundError);
  });

  it('参数非法时返回 isError 而非抛错', async () => {
    const registry = createToolRegistry();
    registry.register(
      new EchoTool('strict', () => 'ok', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
    );
    const result = await registry.invoke('strict', {});
    expect(result.isError).toBe(true);
  });
});

describe('事件（自带发射器，D14）', () => {
  it('注册/注销各发一次事件，含 providerId', () => {
    const registry = createToolRegistry();
    const registered: Array<{ name: string; providerId?: string }> = [];
    const unregistered: Array<{ name: string; providerId?: string }> = [];

    registry.on('tools/registered', (e) => registered.push(e));
    registry.on('tools/unregistered', (e) => unregistered.push(e));

    const dispose = registry.register(tool('watched'), { providerId: 'p' });
    dispose();

    expect(registered).toEqual([{ name: 'watched', providerId: 'p' }]);
    expect(unregistered).toEqual([{ name: 'watched', providerId: 'p' }]);
  });

  it('invoke / result 事件成对出现，且 invoke 在校验之前发出', async () => {
    const registry = createToolRegistry();
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const results: Array<{ name: string; isError: boolean; elapsedMs: number }> = [];

    registry.on('tools/invoke', (e) => invoked.push(e));
    registry.on('tools/result', (e) => results.push({ name: e.name, isError: e.result.isError === true, elapsedMs: e.elapsedMs }));

    registry.register(
      new EchoTool('strict', () => 'ok', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
    );

    // 参数非法：invoke 仍应发出（便于观测模型给了什么）
    await registry.invoke('strict', { wrong: 1 });

    expect(invoked).toEqual([{ name: 'strict', args: { wrong: 1 } }]);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(typeof results[0]!.elapsedMs).toBe('number');
  });

  it('失败结果同时触发 tools/error', async () => {
    const registry = createToolRegistry();
    const errors: Array<{ name: string; code: string }> = [];
    registry.on('tools/error', (e) => errors.push({ name: e.name, code: e.error.code }));

    registry.register(new EchoTool('bad', () => ({ text: '失败', isError: true })));
    await registry.invoke('bad', {});

    expect(errors).toEqual([{ name: 'bad', code: 'TOOLS_EXEC_FAILED' }]);
  });

  it('成功结果不触发 tools/error', async () => {
    const registry = createToolRegistry();
    const onError = vi.fn();
    registry.on('tools/error', onError);

    registry.register(new EchoTool('good', () => 'ok'));
    await registry.invoke('good', {});

    expect(onError).not.toHaveBeenCalled();
  });

  it('取消订阅后不再收到事件', () => {
    const registry = createToolRegistry();
    const seen: string[] = [];
    const off = registry.on('tools/registered', (e) => seen.push(e.name));

    registry.register(tool('a'));
    off();
    registry.register(tool('b'));

    expect(seen).toEqual(['a']);
  });

  it('监听器抛错不影响注册流程（事件是只读观测）', () => {
    const registry = createToolRegistry();
    registry.on('tools/registered', () => {
      throw new Error('监听器故障');
    });
    expect(() => registry.register(tool('robust'))).not.toThrow();
    expect(registry.get('robust')).toBeDefined();
  });

  it('同一事件多监听器全部收到', () => {
    const registry = createToolRegistry();
    const a: string[] = [];
    const b: string[] = [];
    registry.on('tools/registered', (e) => a.push(e.name));
    registry.on('tools/registered', (e) => b.push(e.name));

    registry.register(tool('multi'));
    expect(a).toEqual(['multi']);
    expect(b).toEqual(['multi']);
  });
});

describe('独立实例互不干扰', () => {
  it('两个 registry 各自独立', () => {
    const r1: ToolRegistry = createToolRegistry();
    const r2 = createToolRegistry();
    r1.register(tool('only-in-r1'));
    expect(r1.count()).toBe(1);
    expect(r2.count()).toBe(0);
  });
});
