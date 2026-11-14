/**
 * 主工程宿主入口。
 *
 * 职责边界（与 core 的分工，见设计 D1 / README「分层判据」）：
 * - core 回答「插件长什么样、往哪挂、挂了怎么撤」；
 * - 本模块回答「挂载哪些插件、按什么顺序、启停状态、清单存哪、重启后怎么还原」。
 *
 * 本轮（P0）只搭基础框架：建 host + 根 Context + 两个基础服务 + 启停骨架。
 * 业务装配（`src/`）一律不迁移，后续按「包装不启用 → 双写对照 → 切换删旧」渐进。
 */
import { createHost, createRootContext, type Context, type CoreHost } from '@loop-agent/core';
import type { EventMapBase } from '@loop-agent/core';
import { join } from 'node:path';

import { loopAgentHome } from './home.js';
import {
  PersistentPluginRegistry,
  type PersistentPluginRegistryOptions,
} from './registry.js';
import { createPluginStore } from './store.js';

/** 极简日志契约；默认落 console，可由调用方替换（如接主工程 logger）。 */
export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** 用户目录服务（`main:home`）。 */
export interface HomeService {
  /** 用户级数据根目录（`~/.loop-agent`） */
  readonly dir: string;
  /**
   * 插件目录。
   *
   * 随 `dir` 联动计算，**不**读环境变量：否则调用方注入自定义 home 后，
   * 插件目录仍会指向真实用户目录，测试会污染现场。
   */
  readonly pluginsDir: string;
}

/** 基础服务的 key（集中在此，便于插件侧按名注入）。 */
export const MAIN_SERVICE_KEYS = {
  logger: 'main:logger',
  home: 'main:home',
} as const;

export interface MainHostOptions<E extends EventMapBase = EventMapBase> {
  /** 复用已有 host（测试 / 多宿主场景）；缺省自建 */
  host?: CoreHost<E>;
  /** 覆盖日志实现；缺省 console */
  logger?: Logger;
  /** 覆盖用户目录；缺省 `loopAgentHome()`。测试请传 `mkdtempSync` 的绝对路径 */
  home?: string;
  /** 覆盖清单文件路径（测试注入临时目录）；缺省 `<home>/plugins/registry.json` */
  manifestFile?: string;
  /** 覆盖插件加载器（测试注入内存插件）；缺省动态 `import()` */
  loadPlugin?: PersistentPluginRegistryOptions<E>['loadPlugin'];
}

export interface MainHost<E extends EventMapBase = EventMapBase> {
  /** core 宿主（服务表 + 事件总线 + Fiber 树） */
  readonly host: CoreHost<E>;
  /** 根 Context；在它上面 provide 的服务对所有插件可见 */
  readonly context: Context<E>;
  /** 持久化插件注册中心 */
  readonly registry: PersistentPluginRegistry<E>;
  readonly logger: Logger;
  readonly home: HomeService;
  /** 启动：还原清单并挂载启用中的插件 */
  start(): Promise<void>;
  /** 优雅关停：逆序卸载全部插件 + 清空基础服务，幂等 */
  stop(): Promise<void>;
}

/** 缺省日志实现：只加统一前缀，不做分级过滤（基础框架要薄）。 */
function createConsoleLogger(): Logger {
  return {
    info: (msg, meta) => {
      if (meta === undefined) console.info(`[main] ${msg}`);
      else console.info(`[main] ${msg}`, meta);
    },
    warn: (msg, meta) => {
      if (meta === undefined) console.warn(`[main] ${msg}`);
      else console.warn(`[main] ${msg}`, meta);
    },
    error: (msg, meta) => {
      if (meta === undefined) console.error(`[main] ${msg}`);
      else console.error(`[main] ${msg}`, meta);
    },
  };
}

/**
 * 建主工程宿主。
 *
 * 返回值里的 `start` / `stop` 是骨架：`start` 待任务 03 接线到注册中心
 * `restore()`，`stop` 已具备幂等与「清空基础服务」语义，届时只需在其内部
 * 追加注册中心 `dispose()`。
 */
export function createMainHost<E extends EventMapBase = EventMapBase>(
  options: MainHostOptions<E> = {},
): MainHost<E> {
  const host = options.host ?? createHost<E>();
  const context = createRootContext<E>(host);
  const logger = options.logger ?? createConsoleLogger();

  const homeDir = options.home ?? loopAgentHome();
  const home: HomeService = { dir: homeDir, pluginsDir: join(homeDir, 'plugins') };

  // 基础服务只放 2 个（D14）：业务服务各自做成插件，不预置进 main，
  // 否则 main 会退化成又一个 initRuntime()。
  const disposers = [
    context.provide<Logger>(MAIN_SERVICE_KEYS.logger, logger),
    context.provide<HomeService>(MAIN_SERVICE_KEYS.home, home),
  ];

  const registry = new PersistentPluginRegistry<E>({
    context,
    host,
    // 清单默认紧随 home，便于测试整体重定向（D3）
    store: createPluginStore({
      file: options.manifestFile ?? join(home.pluginsDir, 'registry.json'),
    }),
    ...(options.loadPlugin ? { loadPlugin: options.loadPlugin } : {}),
  });

  let stopPromise: Promise<void> | undefined;

  return {
    host,
    context,
    registry,
    logger,
    home,

    async start(): Promise<void> {
      // 读清单 → 挂载 enabled 插件；坏档已由 store 降级为空清单，不会抛错
      await registry.restore();
    },

    stop(): Promise<void> {
      // 幂等：与 core Fiber.dispose 的语义保持一致
      if (!stopPromise) {
        stopPromise = (async () => {
          // 先由注册中心按挂载逆序卸载（它记录了 id ↔ Fiber 的对应关系），
          // 再撤销基础服务，避免出现「插件已卸但服务仍可见」的中间态。
          await registry.dispose();
          for (const dispose of [...disposers].reverse()) dispose();
          await host.settle();
        })();
      }
      return stopPromise;
    },
  };
}
