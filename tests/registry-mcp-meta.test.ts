// ToolRegistry 与 MCP 展示元信息侧表的契约测试（需求 20261104-001，D9/D15）
//
// 本文件锁死两条铁律：
// 1. `toOpenAITools()` 的输出与展示元信息**完全无关**——无论侧表有没有数据，
//    发往模型的 tools 数组逐字节不变（否则前缀缓存全量失效，不可回滚）。
// 2. 侧表生命周期随 server 连接/断开走：注册即采集、断开即清理、`meta:false` 不采集。
//
// 做法：用 vi.mock 替掉 MCPClient（避免真起子进程），只替换「连接 + 列工具」两处。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: {
    tools: [] as unknown[],
    connects: 0,
  },
}));

vi.mock('../src/tools/mcp/client.js', () => {
  class MCPClient {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    async connect(): Promise<void> {
      h.state.connects += 1;
    }
    async listTools(): Promise<{ tools: unknown[] }> {
      return { tools: h.state.tools };
    }
    async callTool(): Promise<{ content: unknown[] }> {
      return { content: [] };
    }
    async checkHealth(): Promise<boolean> {
      return true;
    }
    async disconnect(): Promise<void> {
      /* 无需清理 */
    }
  }
  return {
    MCPClient,
    normalizeMcpTransportType: (t: string) => t,
  };
});

const { ToolRegistry } = await import('../src/tools/registry.js');

/** 造一个最简 Tool（只有 toOpenAITools 关心的四个字段） */
function fakeTool(name: string, description: string, parameters: Record<string, unknown>) {
  return { name, description, parameters, execute: async () => '' };
}

beforeEach(() => {
  h.state.tools = [];
  h.state.connects = 0;
});

describe('toOpenAITools：与展示元信息完全解耦（D9）', () => {
  it('按名排序 + 参数键规范化，序列化结果确定', () => {
    const r = new ToolRegistry();
    // 故意乱序注册 + 参数键乱序，验证排序与 canonicalize
    r.register(fakeTool('zebar', 'Z', { b: 1, a: { y: 2, x: 3 } }));
    r.register(fakeTool('alpha', 'A', { type: 'object' }));
    expect(JSON.stringify(r.toOpenAITools())).toBe(
      '[' +
        '{"type":"function","function":{"name":"alpha","description":"A","parameters":{"type":"object"}}},' +
        '{"type":"function","function":{"name":"zebar","description":"Z","parameters":{"a":{"x":3,"y":2},"b":1}}}' +
        ']',
    );
  });

  it('MCP 元信息存在时输出逐字节不变（不含 title/annotations/zh 字段）', async () => {
    const r = new ToolRegistry();
    h.state.tools = [
      {
        name: 'shortestPath',
        description: '在指定的图实例下，查询两个节点之间的最短路径',
        inputSchema: { type: 'object', properties: { graph: { description: '图实例' } }, required: ['graph'] },
      },
    ];

    // 采集前（临时连接，meta:false）的快照
    await r.registerMCPServer('g', { type: 'sse', url: 'http://x' }, { meta: false });
    const before = JSON.stringify(r.toOpenAITools());
    await r.disconnectMCPServer('g');
    expect(r.mcpToolMeta()).toHaveLength(0);

    // 采集后（正常注册）的快照
    await r.registerMCPServer('g', { type: 'sse', url: 'http://x' });
    const after = JSON.stringify(r.toOpenAITools());

    expect(after).toBe(before);
    expect(after).not.toContain('title');
    expect(after).not.toContain('annotations');
    expect(after).not.toContain('zhName');
  });
});

describe('MCP 展示元信息侧表：注册即采集（D4）', () => {
  it('注册后侧表有数据，中文描述就地提炼（零 LLM）', async () => {
    const r = new ToolRegistry();
    h.state.tools = [
      {
        name: 'shortestPath',
        description: '在指定的图实例下，查询两个节点之间的最短路径',
        inputSchema: {
          type: 'object',
          properties: { graph: { description: '图实例' }, startIds: { type: 'string' } },
          required: ['graph', 'startIds'],
        },
      },
      {
        name: 'web_search',
        title: 'Web Search',
        annotations: { title: '网页检索' },
        // 中文描述 → 本地提炼，绝不触发 LLM（避免单测发网络请求）
        description: '搜索网络内容并返回结果',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    await r.registerMCPServer('srv', { type: 'sse', url: 'http://x' });
    const metas = r.mcpToolMeta();

    expect(metas.map((m) => m.fullName)).toEqual(['srv__shortestPath', 'srv__web_search']);
    // 中文描述 → 本地提炼，跳过 LLM
    const sp = metas[0]!;
    expect(sp.nameSource).toBe('cjk');
    expect(sp.translate).toBe('skipped');
    expect(sp.zhName.length).toBeGreaterThan(0);
    expect(sp.zhParams.graph).toBe('图实例');
    expect(sp.required).toEqual(['graph', 'startIds']);
    // 顶层 title 优先于 annotations.title
    const ws = metas[1]!;
    expect(ws.title).toBe('Web Search');
  });

  it('meta:false 不采集元信息（临时连接场景，D15）', async () => {
    const r = new ToolRegistry();
    h.state.tools = [
      { name: 't', description: '中文描述', inputSchema: { type: 'object', properties: {} } },
    ];
    await r.registerMCPServer('tmp', { type: 'sse', url: 'http://x' }, { meta: false });
    expect(r.list().map((t) => t.name)).toEqual(['tmp__t']);
    expect(r.mcpToolMeta()).toHaveLength(0);
  });

  it('断开 server 清理该 server 的元信息，其他 server 不受影响', async () => {
    const r = new ToolRegistry();
    h.state.tools = [
      { name: 'a', description: '中文描述甲', inputSchema: { type: 'object', properties: {} } },
    ];
    await r.registerMCPServer('one', { type: 'sse', url: 'http://x' });
    await r.registerMCPServer('two', { type: 'sse', url: 'http://x' });
    expect(r.mcpToolMeta()).toHaveLength(2);

    await r.disconnectMCPServer('one');
    expect(r.mcpToolMeta().map((m) => m.server)).toEqual(['two']);

    await r.disconnectAllMCP();
    expect(r.mcpToolMeta()).toHaveLength(0);
  });
});
