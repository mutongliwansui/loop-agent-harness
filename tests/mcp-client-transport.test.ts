// MCP 传输单测（Task-20261015-001）
// 覆盖：normalizeMcpTransportType 归一化（D1）、createTransport 三分支选择（D5）、
//       未知 type 报错、headers 透传（D2）、describeServer 脱敏（D7）
import { describe, it, expect } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createTransport,
  normalizeMcpTransportType,
  type MCPServerConfig,
} from '../src/tools/mcp/client.js';
import { describeServer } from '../src/commands/mcp-command.js';

describe('normalizeMcpTransportType（D1）', () => {
  it('识别主值与生态别名（大小写/空格不敏感）', () => {
    expect(normalizeMcpTransportType('stdio')).toBe('stdio');
    expect(normalizeMcpTransportType('SSE')).toBe('sse');
    expect(normalizeMcpTransportType('streamableHttp')).toBe('streamableHttp');
    expect(normalizeMcpTransportType('http')).toBe('streamableHttp');
    expect(normalizeMcpTransportType('streamable-http')).toBe('streamableHttp');
    expect(normalizeMcpTransportType('  HTTP  ')).toBe('streamableHttp');
  });

  it('未知类型返回 null', () => {
    expect(normalizeMcpTransportType('ws')).toBeNull();
    expect(normalizeMcpTransportType('')).toBeNull();
  });
});

describe('createTransport（D5）', () => {
  it('stdio → StdioClientTransport', () => {
    const t = createTransport({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
    expect(t).toBeInstanceOf(StdioClientTransport);
  });

  it('sse → SSEClientTransport', () => {
    const t = createTransport({ type: 'sse', url: 'https://host/sse' });
    expect(t).toBeInstanceOf(SSEClientTransport);
  });

  it('streamableHttp → StreamableHTTPClientTransport', () => {
    const t = createTransport({ type: 'streamableHttp', url: 'https://host/mcp' });
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('生态别名 http 同样构造 StreamableHTTPClientTransport', () => {
    const t = createTransport({
      type: 'http',
      url: 'https://host/mcp',
    } as unknown as MCPServerConfig);
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('headers 透传为 requestInit.headers（D2）', () => {
    const t = createTransport({
      type: 'streamableHttp',
      url: 'https://host/mcp',
      headers: { Authorization: 'Bearer x' },
    });
    const init = (t as unknown as { _requestInit?: { headers?: Record<string, string> } })
      ._requestInit;
    expect(init?.headers).toEqual({ Authorization: 'Bearer x' });
  });

  it('空 headers 对象不传 requestInit', () => {
    const t = createTransport({ type: 'streamableHttp', url: 'https://host/mcp', headers: {} });
    const init = (t as unknown as { _requestInit?: unknown })._requestInit;
    expect(init).toBeUndefined();
  });

  it('未知 type 抛出明确错误', () => {
    expect(() =>
      createTransport({ type: 'ws', url: 'wss://host' } as unknown as MCPServerConfig),
    ).toThrow(/不支持的 MCP 传输类型/);
  });
});

describe('describeServer（D7 脱敏）', () => {
  it('stdio 展示 command 与 args', () => {
    expect(describeServer({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'] })).toBe(
      'stdio: npx -y pkg',
    );
  });

  it('sse 标注已废弃', () => {
    expect(describeServer({ type: 'sse', url: 'https://host/sse' })).toBe(
      'sse（已废弃）: https://host/sse',
    );
  });

  it('streamableHttp 展示 url，headers 仅列键名且不泄露值', () => {
    const s = describeServer({
      type: 'streamableHttp',
      url: 'https://host/mcp',
      headers: { Authorization: 'Bearer secret', 'X-API-Key': 'k' },
    });
    expect(s).toBe('streamableHttp: https://host/mcp headers: [Authorization, X-API-Key]');
    expect(s).not.toContain('secret');
    expect(s).not.toContain('Bearer');
  });

  it('无 headers 时不追加 headers 段', () => {
    expect(describeServer({ type: 'streamableHttp', url: 'https://host/mcp' })).toBe(
      'streamableHttp: https://host/mcp',
    );
  });
});
