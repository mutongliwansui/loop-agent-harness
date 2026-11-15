/**
 * `ToolProvider` 成组约定。
 *
 * 提供者刻意**不做**三件事，测试据此逐条断言：
 * - 不做命名空间前缀（归适配器，D13）
 * - 不做去重（归 registry，D11）
 * - 不做排序（归 toToolDefs，D12）
 */

import { describe, expect, it } from 'vitest';

import { EchoTool, FakeProvider } from './helpers.js';
import { ToolBase, ToolProvider } from '../src/index.js';

describe('ToolProvider 基本形态', () => {
  it('子类只需声明 id 与 create()', async () => {
    const provider = new FakeProvider({ id: 'p', count: 3 });
    expect(provider.id).toBe('p');
    const tools = await provider.create({});
    expect(tools).toHaveLength(3);
    expect(tools.every((t) => t instanceof ToolBase)).toBe(true);
  });

  it('create() 允许异步', async () => {
    const provider = new FakeProvider({ id: 'async', count: 2, async: true });
    const tools = await provider.create({});
    expect(tools).toHaveLength(2);
  });

  it('create() 收到传入的 options', async () => {
    const provider = new FakeProvider({ id: 'p' });
    await provider.create({ apiKey: 'k', enabled: true });
    expect(provider.seenOptions[0]).toEqual({ apiKey: 'k', enabled: true });
  });

  it('displayName 可选；未声明时为 undefined（回落逻辑在 define 层）', () => {
    expect(new FakeProvider({ id: 'a' }).displayName).toBeUndefined();
    expect(new FakeProvider({ id: 'b', displayName: '可视化' }).displayName).toBe('可视化');
  });

  it('inject 可选，缺省 undefined', () => {
    expect(new FakeProvider({ id: 'p' }).inject).toBeUndefined();
  });
});

describe('ToolProvider 生命周期', () => {
  it('dispose() 转发到 onDispose()', async () => {
    const provider = new FakeProvider({ id: 'p' });
    await provider.dispose();
    expect(provider.disposeCount).toBe(1);
  });

  it('未声明 onDispose 时 dispose() 安全返回（基类空实现）', async () => {
    class BareProvider extends ToolProvider {
      readonly id = 'bare';
      create(_options: Record<string, unknown>): ToolBase[] {
        return [];
      }
    }
    await expect(new BareProvider().dispose()).resolves.toBeUndefined();
  });

  it('onDispose 抛错时 dispose() 会把错误抛给调用方（由框架吞掉）', async () => {
    class BadDispose extends ToolProvider {
      readonly id = 'bad';
      create(_options: Record<string, unknown>): ToolBase[] {
        return [];
      }
      protected override async onDispose(): Promise<void> {
        throw new Error('释放失败');
      }
    }
    // 吞掉异常的责任在框架（define.ts 的 effect），不在 provider 自己
    await expect(new BadDispose().dispose()).rejects.toThrow('释放失败');
  });
});

describe('提供者不做的事（职责边界）', () => {
  it('不加命名空间前缀：工具名与 create() 给出的名字完全一致', async () => {
    class PlainProvider extends ToolProvider {
      readonly id = 'mcp-fs';
      create(_options: Record<string, unknown>): ToolBase[] {
        return [new EchoTool('readFile')];
      }
    }
    const [tool] = await new PlainProvider().create({});
    // 若提供者擅自加前缀会变成 mcp-fs__readFile
    expect(tool!.name).toBe('readFile');
  });

  it('不去重：create() 返回重名工具由 registry 报冲突', async () => {
    class DupProvider extends ToolProvider {
      readonly id = 'dup';
      create(_options: Record<string, unknown>): ToolBase[] {
        return [new EchoTool('same'), new EchoTool('same')];
      }
    }
    const tools = await new DupProvider().create({});
    // 提供者原样返回两个同名项，不做自我去重
    expect(tools.map((t) => t.name)).toEqual(['same', 'same']);
  });

  it('不排序：create() 的返回顺序被完整保留', async () => {
    class UnorderedProvider extends ToolProvider {
      readonly id = 'u';
      create(_options: Record<string, unknown>): ToolBase[] {
        return [new EchoTool('z'), new EchoTool('a'), new EchoTool('m')];
      }
    }
    const tools = await new UnorderedProvider().create({});
    expect(tools.map((t) => t.name)).toEqual(['z', 'a', 'm']);
  });
});
