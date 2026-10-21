// 工作空间运行时容器（Task-20261021-010-01）
//
// 背景：当前「工作空间」不是一等对象，而是散落在四处的可变字段（process.cwd / SessionStore
// .workspaceId / ConfigLoader.workspacePath / AgentPool 的 initAgent 闭包），一次切换要四份
// 状态一起搬，因此不可能有两个空间同时活动。本模块建立「每空间一个不可变运行时对象」的容器。
//
// 设计决策（详见 docs/tasks/optimizations/task-20261021-010-01-*.md）：
// - D2  不改 workspaceId() 公式；同一物理目录的各种书写经 canonicalWorkspacePath() 收敛
// - D1  LRU 限量（默认 4，LOOP_AGENT_MAX_WORKSPACES 可调），空闲 30min evictIdle() 释放
// - L1  本阶段只装启动目录一个 runtime；HandlerContext 字段不变（bootstrap 从 runtime 解构注入），
//       保证对外行为零变化
// - L3  get() 缓存 Promise（而非实例），并发同 root 只建一份 store
//
// 不变量：
// - 同一 canonical root 任意时刻只有一个 runtime
// - root / id / store 创建后不可变（与 SessionStore.rebindWorkspace 的原地改写相反）
// - list().length <= maxRuntimes

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { AgentPool } from '../agent/agent-pool.js';
import { ConfigLoader } from '../config/loader.js';
import { ConfigWriter } from '../config/writer.js';
import { canonicalWorkspacePath } from '../session/path-utils.js';
import { SessionStore, workspaceId } from '../session/index.js';
import { SkillLoader } from '../skill/loader.js';
import { runWithWorkspace } from '../runtime/workspace-context.js';
import { debug } from '../debug.js';
import type { AgentOptions, AgentResult } from '../types.js';
import { ApiHttpError } from './errors.js';
import { getMemoryKit, type MemoryKit } from './memory-kit.js';
import { SessionManager } from './session-manager.js';

/** 单次 run 的执行签名（与 ApiServerDeps.runAgent 同构） */
export type RuntimeRunAgent = (
  sessionId: string,
  input: string,
  options: AgentOptions,
) => Promise<AgentResult>;

/** 单个工作空间的运行时（root/id/store 建立后不可变） */
export interface WorkspaceRuntime {
  /** canonical 绝对路径（registry 的键） */
  readonly root: string;
  /** workspaceId(root)：会话目录名，公式未变（D2） */
  readonly id: string;
  readonly store: SessionStore;
  /** workspace 层指向 root 的独立加载器（不再 setWorkspacePath 原地改写，后续任务的 P0 形态） */
  readonly configLoader: ConfigLoader;
  readonly configWriter: ConfigWriter;
  /** 本空间的会话缓存与互斥状态（hasInFlight 即"本空间是否有 run"） */
  readonly sessions: SessionManager;
  /** 本空间的技能加载器（实例级 Map 隔离，避免两空间 scan 互相覆盖，D14） */
  readonly skillLoader: SkillLoader;
  /** 本空间的 agent 实例池（每空间一池） */
  readonly pool: AgentPool;
  /** 本空间共享记忆 kit（按 workspaceId 缓存，池内实例共享） */
  getMemoryKit(): Promise<MemoryKit>;
  /** 在本空间 ALS 上下文内租用本空间池实例执行 run（切换空间后 handler 改用新 runtime 的此方法） */
  runAgent: RuntimeRunAgent;
  /** LRU 依据（可变） */
  lastUsedAt: number;
}

export interface WorkspaceRegistryOptions {
  /** 同时保有的 runtime 上限（默认 4；缺省读 LOOP_AGENT_MAX_WORKSPACES） */
  maxRuntimes?: number;
  /** 每个 runtime 的 agent 池容量（默认 4；缺省读 LOOP_AGENT_POOL_CAPACITY） */
  poolCapacity?: number;
  /** 空闲释放阈值（默认 30min） */
  idleTtlMs?: number;
  /** 会话/密钥根目录覆盖（默认 ~/.loop-agent；仅单测隔离用，避免污染真实用户目录） */
  userDir?: string;
}

/** 读正整数环境变量，非法时回退默认值并记一条日志 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    debug.log(`[registry] 环境变量 ${name} 非法（${raw}），回退默认值 ${fallback}`);
    return fallback;
  }
  return n;
}

const DEFAULT_MAX_RUNTIMES = 4;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * 校验目录存在且可进入（stat + access R|X），返回 canonical root。
 *
 * 原 sessions.ts 私有 `ensureDirUsable` 上移为共享实现，供 registry 建 runtime 前
 * 与 handler 侧切换空间前复用（保持 not_found / forbidden 的错误码与文案一致）。
 */
export async function ensureDirUsable(input: string): Promise<string> {
  const root = await canonicalWorkspacePath(input);
  let isDir: boolean;
  try {
    isDir = (await stat(root)).isDirectory();
  } catch {
    throw new ApiHttpError('not_found', `目录不存在: ${root}`);
  }
  if (!isDir) throw new ApiHttpError('not_found', `不是目录: ${root}`);
  try {
    await access(root, constants.R_OK | constants.X_OK);
  } catch {
    throw new ApiHttpError('forbidden', `无权访问目录: ${root}`);
  }
  return root;
}

/**
 * 工作空间运行时注册表：按 canonical root 懒建并缓存 runtime。
 *
 * 本阶段（P0/P1）只被 bootstrap 用来装启动目录一个实例，行为与改造前一致；
 * 后续任务据此让多个空间并存。
 */
export class WorkspaceRegistry {
  private readonly runtimes = new Map<string, WorkspaceRuntime>();
  /** 建造中的 runtime（L3：并发 get 共享同一 Promise，避免双份 store） */
  private readonly building = new Map<string, Promise<WorkspaceRuntime>>();
  private readonly maxRuntimes: number;
  private readonly poolCapacity: number;
  private readonly idleTtlMs: number;
  private readonly userDir?: string;

  constructor(opts: WorkspaceRegistryOptions = {}) {
    this.maxRuntimes = opts.maxRuntimes ?? intFromEnv('LOOP_AGENT_MAX_WORKSPACES', DEFAULT_MAX_RUNTIMES);
    this.poolCapacity = opts.poolCapacity ?? intFromEnv('LOOP_AGENT_POOL_CAPACITY', 4);
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.userDir = opts.userDir;
  }

  /** 当前保有的 runtime 数量上限 */
  get limit(): number {
    return this.maxRuntimes;
  }

  /**
   * 取（必要时懒建）指定空间的 runtime。
   * 入参可以是任意书写形式（相对/大小写/尾斜杠），内部先 canonical 化。
   */
  async get(input: string): Promise<WorkspaceRuntime> {
    return this.getCanonical(await canonicalWorkspacePath(input));
  }

  /** 已 canonical 化 root 的取建入口（供内部链式调用，避免重复 realpath） */
  async getCanonical(root: string): Promise<WorkspaceRuntime> {
    const hit = this.runtimes.get(root);
    if (hit) {
      hit.lastUsedAt = Date.now();
      return hit;
    }
    const inflight = this.building.get(root);
    if (inflight) return inflight;

    const task = this.build(root)
      .then((rt) => {
        this.building.delete(root);
        return rt;
      })
      .catch((e: unknown) => {
        this.building.delete(root);
        throw e;
      });
    this.building.set(root, task);
    return task;
  }

  /**
   * 同步查已建 runtime（root 必须是 canonical 形式）。
   * 用于"是否已装载"类判定，不触发建造。
   */
  peek(root: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(root);
  }

  /**
   * 校验目录存在且可进入（原 sessions.ts 私有 ensureDirUsable 上移）。
   * 返回 canonical root，便于调用方接着 get()。
   */
  async ensureRoot(input: string): Promise<string> {
    return ensureDirUsable(input);
  }

  /** 当前保有的 runtime 列表（按最近使用降序，便于观测） */
  list(): WorkspaceRuntime[] {
    return [...this.runtimes.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /**
   * 回收：先按空闲超时释放，再按 LRU 淘汰超出上限的部分。
   * 有 in-flight run 的 runtime 一律跳过（并刷新其 lastUsedAt，避免下一轮被误判为空闲）。
   */
  evictIdle(now: number = Date.now()): void {
    for (const [root, rt] of [...this.runtimes]) {
      if (this.busy(rt)) {
        rt.lastUsedAt = now;
        continue;
      }
      if (now - rt.lastUsedAt >= this.idleTtlMs) this.dispose(root, rt);
    }

    while (this.runtimes.size > this.maxRuntimes) {
      const candidates = [...this.runtimes].filter(([, rt]) => !this.busy(rt));
      if (candidates.length === 0) break; // 全部在跑：宁可超限也不打断 run
      candidates.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      const [root, rt] = candidates[0];
      this.dispose(root, rt);
    }
  }

  /** 清空全部 runtime（测试/关停用；生产不得在运行期调用） */
  reset(): void {
    for (const rt of this.runtimes.values()) rt.pool.reset();
    this.runtimes.clear();
    this.building.clear();
    debug.log('[registry] 已重置（全部工作空间运行时释放）');
  }

  /** 建造一个 runtime：store 按 root 构造并 init（init 幂等），池钩子注入本空间共享 kit */
  private async build(root: string): Promise<WorkspaceRuntime> {
    // 构造期定根（D7）：workspace 层永远指向本空间，serve 侧不再 setWorkspacePath 原地改写
    const configLoader = new ConfigLoader(root);
    const { config: cfg } = configLoader.load();
    const store = new SessionStore(root, cfg.session.encryptionEnabled, this.userDir);
    await store.init();

    const configWriter = new ConfigWriter(root, undefined, configLoader);
    const sessions = new SessionManager(store);
    // 每 runtime 一个技能加载器（D14）：实例内 Map 不会被其他空间的 scan() 覆盖
    const skillLoader = new SkillLoader();
    if (cfg.skill.enabled && cfg.skill.autoLoad) skillLoader.scan(root);
    const id = workspaceId(root);

    // rt 自引用：initAgent 钩子需在实例创建后取其共享 kit（禁止每实例自建记忆）
    let rt!: WorkspaceRuntime;
    const pool = new AgentPool({ capacity: this.poolCapacity }, async (a) => {
      // Task-20261021-010-02 D3/D4：池内实例显式绑定本空间根（每空间一池），
      // 工具调用与技能扫描不再依赖进程 cwd；attachMemory 的 workspaceId 也取同一根。
      a.setWorkspaceRoot(root);
      await a.attachMemory(await rt.getMemoryKit(), root);
    });

    rt = {
      root,
      id,
      store,
      configLoader,
      configWriter,
      sessions,
      skillLoader,
      pool,
      getMemoryKit: () => getMemoryKit(root),
      // run 全程处于本空间 ALS 上下文（漏传显式根的深层代码仍能取到正确的根）；
      // 每空间一池，run 只可能落在本空间实例上（切换空间仅更换 handler 指针）
      runAgent: (sessionId, input, options) =>
        runWithWorkspace({ root, id }, () => pool.withAgent(sessionId, (a) => a.run(input, options))),
      lastUsedAt: Date.now(),
    };
    this.runtimes.set(root, rt);
    debug.log(
      `[registry] 已装载工作空间运行时: ${root}（id=${rt.id}，当前 ${this.runtimes.size}/${this.maxRuntimes}）`,
    );
    return rt;
  }

  /** 本空间是否有正在处理的 run */
  private busy(rt: WorkspaceRuntime): boolean {
    return rt.sessions.hasInFlight();
  }

  /** 释放单个 runtime：池内实例 dispose，缓存移除 */
  private dispose(root: string, rt: WorkspaceRuntime): void {
    this.runtimes.delete(root);
    try {
      rt.pool.reset();
    } catch (e) {
      debug.log(`[registry] 释放池失败（${root}）: ${e instanceof Error ? e.message : String(e)}`);
    }
    debug.log(`[registry] 已释放工作空间运行时: ${root}`);
  }
}
