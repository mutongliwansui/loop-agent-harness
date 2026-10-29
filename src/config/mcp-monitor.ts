// MCP 监测器：服务启动后接管 MCP server 的「连接 / 探活 / 自动恢复 / 配置热更新」
//
// 设计目的（2026-10-29）：启动关键路径不再等待 MCP 连接。serve 模式下 initRuntime 跳过
// 阻塞加载，由本监测器在后台首轮连接；此后每隔 intervalMs 一轮：
//   - 配置 diff：新增 → 连接，删除 → 断开，变更 → 断开并在下轮重连（无需手动 POST /mcp/reload）
//   - 已连接 → ping 探活，失败即断开并按指数退避重连
//   - 未连接 → 退避到期后重连（stdi server 反复 spawn 代价高，故必须退避）
//
// 并发保护：per-server busy 标记（同一 server 的连接/探活/断开互斥），
// cancelled 标记（连接过程中配置被移除/变更 → 连接成功后立刻断开，不留孤儿连接）。

import { registry } from '../tools/registry.js';
import { debug } from '../debug.js';
import type { MCPManager } from './mcp-manager.js';
import type { ConfigLoader } from './loader.js';
import type { MCPServerConfig } from '../tools/mcp/client.js';

/** server 运行态：pending=尚未尝试，connecting=连接中，connected=可用，failed=上次失败待重试 */
export type McpServerState = 'pending' | 'connecting' | 'connected' | 'failed';

/** 对外可观测快照（/status、GET /mcp/servers 使用） */
export interface McpServerRuntimeStatus {
  name: string;
  state: McpServerState;
  toolCount: number;
  /** 连续失败次数（成功后归零） */
  retries: number;
  lastError?: string;
  /** 最近一次探活时间（epoch ms） */
  lastCheckAt?: number;
  /** 下次重连时间（epoch ms，仅在 failed 时有值） */
  nextRetryAt?: number;
}

interface ServerState {
  state: McpServerState;
  retries: number;
  lastError?: string;
  lastCheckAt?: number;
  nextRetryAt?: number;
}

export interface McpMonitorOptions {
  /** 轮询周期（默认 30s）：决定探活与重试的检查粒度 */
  intervalMs?: number;
  /** 退避基数（默认 30s）：第 n 次失败后等待 base * 2^(n-1) */
  retryBaseMs?: number;
  /** 退避上限（默认 5min） */
  retryMaxMs?: number;
  /** 状态变化日志出口（默认 console.log） */
  log?: (msg: string) => void;
}

const DEFAULTS = {
  intervalMs: 30_000,
  retryBaseMs: 30_000,
  retryMaxMs: 5 * 60_000,
};

/** 统计某 server 已注册的工具数 */
function toolCountOf(name: string): number {
  const prefix = `${name}__`;
  return registry.list().filter((t) => t.name.startsWith(prefix)).length;
}

export class McpMonitor {
  private timer?: NodeJS.Timeout;
  private running = false;
  /** 上一轮的配置快照，用于 diff（首轮为空对象 → 全部视为新增） */
  private configs: Record<string, MCPServerConfig> = {};
  private readonly states = new Map<string, ServerState>();
  /** 正在连接/探活/断开的 server（互斥） */
  private readonly busy = new Set<string>();
  /** 连接期间配置被移除/变更的 server（连接成功后需立刻断开） */
  private readonly cancelled = new Set<string>();
  private readonly intervalMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly manager: MCPManager,
    private readonly loader: ConfigLoader,
    opts: McpMonitorOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULTS.intervalMs;
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULTS.retryBaseMs;
    this.retryMaxMs = opts.retryMaxMs ?? DEFAULTS.retryMaxMs;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** 启动监测：首轮立即派发（不等待），之后按周期轮询；timer unref 不阻止进程退出 */
  start(): void {
    if (this.timer) return;
    this.running = true;
    this.pump();
    this.timer = setInterval(() => this.pump(), this.intervalMs);
    this.timer.unref?.();
  }

  /** 停止监测（进程关停时调用；进行中的连接由 disconnectAll 收尾） */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 对外快照：配置中的全部 server + 实时状态 */
  snapshot(): McpServerRuntimeStatus[] {
    const connected = new Set(registry.listMCPServers());
    return Object.keys(this.configs).map((name) => {
      const st = this.states.get(name);
      const isConnected = connected.has(name);
      return {
        name,
        // 以 registry 实际连接为准：/mcp/reload、POST /mcp/servers/:name/test 等入口
        // 会绕过监测器直接连/断 registry，此时 states 里的 'connected' 已过期
        state: isConnected
          ? 'connected'
          : st?.state === 'connecting'
            ? 'connecting'
            : st?.state === 'connected'
              ? 'pending'
              : st?.state ?? 'pending',
        toolCount: toolCountOf(name),
        retries: st?.retries ?? 0,
        lastError: st?.lastError,
        lastCheckAt: st?.lastCheckAt,
        nextRetryAt: st?.nextRetryAt,
      };
    });
  }

  /** 单 server 状态（不存在于配置时返回 undefined） */
  statusOf(name: string): McpServerRuntimeStatus | undefined {
    return this.snapshot().find((s) => s.name === name);
  }

  /** 一轮调度：只做同步派发，不等任何连接（异步任务靠 busy 互斥） */
  private pump(): void {
    if (!this.running) return;
    let servers: Record<string, MCPServerConfig>;
    try {
      servers = this.loader.load().config.tools.mcpServers ?? {};
    } catch (e) {
      debug.log(`[mcp] 配置读取失败: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    this.diff(servers);

    const connectedSet = new Set(registry.listMCPServers());
    const now = Date.now();
    for (const [name, cfg] of Object.entries(servers)) {
      if (this.busy.has(name)) continue;
      if (connectedSet.has(name)) {
        void this.probe(name);
        continue;
      }
      const st = this.stateOf(name);
      if (st.nextRetryAt && now < st.nextRetryAt) continue;
      void this.connect(name, cfg);
    }
  }

  /** 配置 diff：移除 → 断开；新增/变更 → 重置退避并断开旧连接（下轮统一重连） */
  private diff(servers: Record<string, MCPServerConfig>): void {
    const prev = this.configs;
    this.configs = servers;

    for (const name of Object.keys(prev)) {
      if (name in servers) continue;
      this.states.delete(name);
      this.cancelled.add(name);
      this.log(`[mcp] 配置已移除: ${name}`);
      void this.disconnect(name);
    }

    for (const [name, cfg] of Object.entries(servers)) {
      const before = prev[name];
      if (before !== undefined && JSON.stringify(before) === JSON.stringify(cfg)) continue;
      const st = this.stateOf(name);
      st.retries = 0;
      st.nextRetryAt = undefined;
      st.lastError = undefined;
      if (registry.listMCPServers().includes(name)) {
        // 配置变更：旧连接必须断开，否则 registerMCPServer 会因「已存在」直接跳过
        this.cancelled.add(name);
        this.log(`[mcp] 配置已变更，准备重连: ${name}`);
        void this.disconnect(name);
      }
    }
  }

  /** 探活：ping 或 listTools 任一有响应即视为健康；都超时才断开并进入退避等待 */
  private async probe(name: string): Promise<void> {
    this.busy.add(name);
    const st = this.stateOf(name);
    try {
      const ok = await registry.healthCheckMCPServer(name);
      st.lastCheckAt = Date.now();
      if (ok) {
        if (st.state !== 'connected') {
          this.log(`[mcp] ${name} 已恢复（${toolCountOf(name)} 个工具）`);
        }
        st.state = 'connected';
        st.retries = 0;
        st.nextRetryAt = undefined;
        st.lastError = undefined;
        return;
      }
      st.lastError = '探活无响应（ping 与 listTools 均超时）';
      const waitMs = this.fail(st);
      this.log(`[mcp] ${name} 掉线（探活无响应），${Math.round(waitMs / 1000)}s 后重连`);
      await registry.disconnectMCPServer(name).catch(() => {});
    } catch (e) {
      st.lastError = e instanceof Error ? e.message : String(e);
      const waitMs = this.fail(st);
      this.log(`[mcp] ${name} 探活异常，${Math.round(waitMs / 1000)}s 后重连: ${st.lastError}`);
      await registry.disconnectMCPServer(name).catch(() => {});
    } finally {
      this.busy.delete(name);
    }
  }

  /** 连接：成功登记 connected；失败按指数退避安排下次重试 */
  private async connect(name: string, cfg: MCPServerConfig): Promise<void> {
    this.busy.add(name);
    this.cancelled.delete(name);
    const st = this.stateOf(name);
    st.state = 'connecting';
    const t0 = Date.now();
    try {
      await this.manager.loadServer(name, cfg);
      if (this.cancelled.has(name)) {
        // 连接期间配置被移除/变更：立刻断开，不留孤儿连接（下一轮按新配置处理）
        this.cancelled.delete(name);
        await registry.disconnectMCPServer(name).catch(() => {});
        debug.log(`[mcp] ${name} 连接期间配置已变更，已断开`);
        return;
      }
      st.state = 'connected';
      st.retries = 0;
      st.nextRetryAt = undefined;
      st.lastError = undefined;
      this.log(`[mcp] ${name} 已连接（${toolCountOf(name)} 个工具, +${Date.now() - t0}ms）`);
    } catch (e) {
      st.lastError = e instanceof Error ? e.message : String(e);
      const waitMs = this.fail(st);
      this.log(
        `[mcp] ${name} 连接失败（第 ${st.retries} 次，${Math.round(waitMs / 1000)}s 后重试）: ${st.lastError}`,
      );
    } finally {
      this.busy.delete(name);
    }
  }

  /** 断开（配置移除/变更时）：若正被连接占用，交由 connect 的 cancelled 检查收尾 */
  private async disconnect(name: string): Promise<void> {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    try {
      await registry.disconnectMCPServer(name);
    } catch (e) {
      debug.log(`[mcp] ${name} 断开失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy.delete(name);
    }
  }

  /** 标记失败并计算退避时间，返回本次等待毫秒数（日志由调用方输出一次） */
  private fail(st: ServerState): number {
    st.state = 'failed';
    st.retries += 1;
    const waitMs = this.backoff(st.retries);
    st.nextRetryAt = Date.now() + waitMs;
    return waitMs;
  }

  private backoff(attempt: number): number {
    return Math.min(this.retryBaseMs * 2 ** Math.max(0, attempt - 1), this.retryMaxMs);
  }

  private stateOf(name: string): ServerState {
    let st = this.states.get(name);
    if (!st) {
      st = { state: 'pending', retries: 0 };
      this.states.set(name, st);
    }
    return st;
  }
}

/**
 * 进程内活动监测器（仅 serve 模式创建）。
 * handlers 只读快照，故用模块级访问器，避免把 monitor 塞进 HandlerContext 影响既有单测。
 */
let active: McpMonitor | undefined;

export function setActiveMcpMonitor(monitor: McpMonitor | undefined): void {
  active = monitor;
}

export function getMcpMonitor(): McpMonitor | undefined {
  return active;
}
