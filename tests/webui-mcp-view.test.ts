/**
 * MCP 页纯逻辑测试（原型-20261109-002 · D1/D2/D3/D7/D9）
 *
 * 覆盖 webui/src/mcp-ui.ts：
 * - normalizeState / stateMeta：state 四态归一与文案
 * - mcpCounts：已登记 / 已连接 / 异常 / 工具总数（异常只计 failed）
 * - filterServers / matchServer：名称 + 连接目标搜索、状态分段
 * - sortServers：状态优先 / 名称 A→Z / 工具数降序
 * - fmtCountdown：重试倒计时向上取整与到期归零
 * - parseLines / parseKv：登记表单的参数与环境变量解析
 * - describeMcpTool：工具清单中文名、来源徽标、失败标记
 *
 * 卡片 DOM 渲染与抽屉/模态交互无 jsdom，改由真实浏览器渲染断言。
 */
import { describe, it, expect } from 'vitest';
import {
  describeMcpTool,
  filterServers,
  fmtCountdown,
  matchServer,
  mcpCounts,
  mcpInitials,
  normalizeState,
  parseKv,
  parseLines,
  scopePath,
  serverTarget,
  sortServers,
  stateMeta,
  type McpServerRow,
  type McpTargetCfg,
} from '../webui/src/mcp-ui.js';
import type { McpToolMeta } from '../webui/src/mcp-tool-meta.js';

const rows: McpServerRow[] = [
  { name: 'postgres', transport: 'stdio', status: 'connected', toolCount: 6, state: 'connected', scope: 'workspace' },
  { name: 'filesystem', transport: 'stdio', status: 'connected', toolCount: 5, state: 'connected', scope: 'global' },
  { name: 'github', transport: 'http', status: 'connected', toolCount: 5, state: 'connected', scope: 'global' },
  { name: 'grafana', transport: 'stdio', status: 'disconnected', toolCount: 0, state: 'failed', lastError: 'spawn npx ENOENT', nextRetryAt: 1000, scope: 'workspace' },
  { name: 'sentry', transport: 'sse', status: 'disconnected', toolCount: 0, state: 'connecting', scope: 'global' },
  { name: 'ghost', transport: 'stdio', status: 'disconnected', toolCount: 0, scope: 'workspace' },
];

const targets: Record<string, McpTargetCfg> = {
  postgres: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost:5432/app'] },
  filesystem: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
  github: { type: 'http', url: 'https://mcp.github.example/v1' },
  grafana: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-grafana'] },
  sentry: { type: 'sse', url: 'https://sentry-mcp.example/sse' },
};

describe('normalizeState / stateMeta', () => {
  it('合法 state 原样返回', () => {
    expect(normalizeState({ state: 'pending', status: 'disconnected' })).toBe('pending');
    expect(normalizeState({ state: 'connecting', status: 'disconnected' })).toBe('connecting');
    expect(normalizeState({ state: 'connected', status: 'connected' })).toBe('connected');
    expect(normalizeState({ state: 'failed', status: 'disconnected' })).toBe('failed');
  });

  it('缺失或非法 state 按 status 回落', () => {
    expect(normalizeState({ status: 'connected' })).toBe('connected');
    expect(normalizeState({ status: 'disconnected' })).toBe('pending');
    expect(normalizeState({ state: 'bogus', status: 'connected' })).toBe('connected');
    expect(normalizeState({ state: 'bogus', status: 'disconnected' })).toBe('pending');
  });

  it('四态文案与 pill 色调', () => {
    expect(stateMeta('pending')).toEqual({ label: '待连接', tone: 'idle' });
    expect(stateMeta('connecting')).toEqual({ label: '连接中', tone: 'warn' });
    expect(stateMeta('connected')).toEqual({ label: '已连接', tone: 'ok' });
    expect(stateMeta('failed')).toEqual({ label: '连接失败', tone: 'err' });
  });
});

describe('serverTarget', () => {
  it('stdio 拼 command + args，远程取 url', () => {
    expect(serverTarget(targets.postgres)).toBe('npx -y @modelcontextprotocol/server-postgres postgresql://localhost:5432/app');
    expect(serverTarget({ command: 'uvx' })).toBe('uvx');
    expect(serverTarget(targets.github)).toBe('https://mcp.github.example/v1');
    expect(serverTarget({ type: 'http' })).toBe('—');
  });

  it('配置缺失返回占位符', () => {
    expect(serverTarget(undefined)).toBe('—');
  });
});

describe('mcpCounts', () => {
  it('统计四类数量与工具总数；异常只计 failed', () => {
    expect(mcpCounts(rows)).toEqual({
      total: 6,
      connected: 3,
      failed: 1,
      pending: 1,
      connecting: 1,
      tools: 16,
    });
    expect(mcpCounts([])).toEqual({ total: 0, connected: 0, failed: 0, pending: 0, connecting: 0, tools: 0 });
  });
});

describe('matchServer', () => {
  it('名称命中（不区分大小写）', () => {
    expect(matchServer(rows[0], serverTarget(targets.postgres), 'POSTGRES')).toBe(true);
    expect(matchServer(rows[4], serverTarget(targets.sentry), 'sentry')).toBe(true);
  });

  it('连接目标命中（command 与 URL）', () => {
    expect(matchServer(rows[1], serverTarget(targets.filesystem), 'server-filesystem')).toBe(true);
    expect(matchServer(rows[2], serverTarget(targets.github), 'github.example')).toBe(true);
  });

  it('空查询恒为真；无匹配返回 false；首尾空白不参与匹配', () => {
    expect(matchServer(rows[0], serverTarget(targets.postgres), '   ')).toBe(true);
    expect(matchServer(rows[0], serverTarget(targets.postgres), 'grafana')).toBe(false);
    expect(matchServer(rows[5], '—', '  ghost  ')).toBe(true);
  });
});

describe('filterServers', () => {
  it('all 空查询保留全部与入参顺序', () => {
    expect(filterServers(rows, targets, '', 'all').map((r) => r.name)).toEqual([
      'postgres', 'filesystem', 'github', 'grafana', 'sentry', 'ghost',
    ]);
  });

  it('ok 只保留 connected，bad 只保留 failed', () => {
    expect(filterServers(rows, targets, '', 'ok').map((r) => r.name)).toEqual(['postgres', 'filesystem', 'github']);
    expect(filterServers(rows, targets, '', 'bad').map((r) => r.name)).toEqual(['grafana']);
  });

  it('状态分段与关键字同时生效', () => {
    expect(filterServers(rows, targets, 'npx', 'ok').map((r) => r.name)).toEqual(['postgres', 'filesystem']);
    expect(filterServers(rows, targets, 'mcp-grafana', 'ok')).toEqual([]);
    expect(filterServers(rows, targets, 'mcp-grafana', 'bad').map((r) => r.name)).toEqual(['grafana']);
  });
});

describe('sortServers', () => {
  it('status：失败优先，其次连接中 / 待连接 / 已连接', () => {
    expect(sortServers(rows, 'status').map((r) => r.name)).toEqual([
      'grafana', 'sentry', 'ghost', 'filesystem', 'github', 'postgres',
    ]);
  });

  it('name：全局按名称 A→Z', () => {
    expect(sortServers(rows, 'name').map((r) => r.name)).toEqual([
      'filesystem', 'ghost', 'github', 'grafana', 'postgres', 'sentry',
    ]);
  });

  it('tools：工具数降序，同数按名称', () => {
    expect(sortServers(rows, 'tools').map((r) => r.name)).toEqual([
      'postgres', 'filesystem', 'github', 'ghost', 'grafana', 'sentry',
    ]);
  });

  it('不修改入参数组顺序', () => {
    const input = [...rows];
    sortServers(input, 'status');
    expect(input.map((r) => r.name)).toEqual(rows.map((r) => r.name));
  });
});

describe('fmtCountdown', () => {
  it('向上取整到 mm:ss', () => {
    const now = 1_700_000_000_000;
    expect(fmtCountdown(now + 134_000, now)).toBe('02:14');
    expect(fmtCountdown(now + 500, now)).toBe('00:01');
    expect(fmtCountdown(now + 60_000, now)).toBe('01:00');
  });

  it('已到期或缺失归零', () => {
    const now = 1_700_000_000_000;
    expect(fmtCountdown(now - 5_000, now)).toBe('00:00');
    expect(fmtCountdown(undefined, now)).toBe('00:00');
    expect(fmtCountdown(0, now)).toBe('00:00');
  });
});

describe('展示与解析工具函数', () => {
  it('mcpInitials：字母数字前两位、中文前两位、空名兜底', () => {
    expect(mcpInitials('postgres')).toBe('PO');
    expect(mcpInitials('py-pptx')).toBe('PY');
    expect(mcpInitials('文件系统')).toBe('文件');
    expect(mcpInitials('')).toBe('?');
  });

  it('parseLines：逐行 trim、丢空行、兼容 CRLF', () => {
    expect(parseLines('-y\r\n@modelcontextprotocol/server-postgres\r\n\r\n  postgresql://localhost:5432/app  ')).toEqual([
      '-y',
      '@modelcontextprotocol/server-postgres',
      'postgresql://localhost:5432/app',
    ]);
    expect(parseLines('')).toEqual([]);
  });

  it('parseKv：解析 KEY=VALUE，忽略无等号/空键行', () => {
    expect(parseKv('PGPASSWORD=secret\nA=1=2\nBROKEN\n=novalue\n  TOKEN = abc  ')).toEqual({
      PGPASSWORD: 'secret',
      A: '1=2',
      TOKEN: 'abc',
    });
    expect(parseKv('')).toEqual({});
  });

  it('scopePath：工作空间 / 全局配置路径', () => {
    expect(scopePath('workspace')).toBe('.loop-agent/.agent-config.json');
    expect(scopePath('global')).toBe('~/.loop-agent/config.json');
  });
});

describe('describeMcpTool', () => {
  const baseMeta: McpToolMeta = {
    fullName: 'postgres__query',
    server: 'postgres',
    tool: 'query',
    title: 'Query',
    description: '在已连接的数据库中执行只读 SQL。',
    paramDesc: { sql: 'SQL 语句' },
    required: ['sql'],
    zhName: '执行查询',
    zhParams: { sql: 'SQL 语句' },
    nameSource: 'translate',
    translate: 'done',
  };

  it('有元信息：中文名、原始名、描述、必填参数与来源徽标', () => {
    expect(describeMcpTool('postgres__query', 'raw', baseMeta, 'postgres')).toEqual({
      zh: '执行查询',
      en: 'query',
      desc: '在已连接的数据库中执行只读 SQL。',
      required: ['sql'],
      badge: '译',
      failed: false,
    });
  });

  it('title / 中文描述来源分别显示对应徽标', () => {
    expect(describeMcpTool('postgres__query', 'raw', { ...baseMeta, nameSource: 'title' }, 'postgres').badge).toBe('title');
    expect(describeMcpTool('postgres__query', 'raw', { ...baseMeta, nameSource: 'cjk', zhName: '查询' }, 'postgres').badge).toBe('中文');
    expect(describeMcpTool('postgres__query', 'raw', { ...baseMeta, nameSource: 'none', zhName: '' }, 'postgres').badge).toBe('原文');
  });

  it('翻译失败：标记 failed、徽标回落原文，保留协议描述', () => {
    const failedMeta: McpToolMeta = { ...baseMeta, zhName: '', nameSource: 'none', translate: 'failed', translateError: 'timeout' };
    const view = describeMcpTool('postgres__query', 'raw', failedMeta, 'postgres');
    expect(view.failed).toBe(true);
    expect(view.badge).toBe('原文');
    expect(view.zh).toBe('Query'); // 回落 title 原文
    expect(view.desc).toBe('在已连接的数据库中执行只读 SQL。');
  });

  it('无元信息：去掉 server 前缀、名字美化、使用接口原始描述', () => {
    expect(describeMcpTool('postgres__list_tables', '列出当前 schema 下的数据表', undefined, 'postgres')).toEqual({
      zh: 'List Tables',
      en: 'list_tables',
      desc: '列出当前 schema 下的数据表',
      required: [],
      badge: '原文',
      failed: false,
    });
  });

  it('无描述时回落「无描述」；无 server 参数时保留全名', () => {
    const view = describeMcpTool('postgres__query', '', undefined);
    expect(view.en).toBe('postgres__query');
    expect(view.zh).toBe('Postgres Query');
    expect(view.desc).toBe('无描述');
  });
});
