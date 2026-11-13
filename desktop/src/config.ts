import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 后端默认端口，与后端配置缺省一致；被占时由选端口逻辑顺延 */
export const DEFAULT_PORT = 3000;

/** Dreaming 关停预算缺省值，与后端 src/memory/types.ts 的 30000 保持一致 */
export const DEFAULT_SHUTDOWN_BUDGET_MS = 30_000;

export interface ShellConfig {
  /** 首选端口（读不到配置时为 DEFAULT_PORT） */
  port: number;
  /** api.token；为空表示后端不校验 token（回环放行） */
  token: string;
  /**
   * 关停时 Dreaming 的预算（memory.dreaming.shutdownBudgetMs）。
   *
   * 壳必须知道这个值：关停等待上限 = 预算 + 宽限（D2-4），
   * 用固定超时会在用户调大预算时提前强杀，反而丢记忆。
   */
  shutdownBudgetMs: number;
}

/**
 * 壳可见的 .loop-agent 目录。
 *
 * 必须与后端 loopAgentHome() 的解析顺序一致，否则隔离运行（LOOP_AGENT_HOME）
 * 时壳读真实配置、后端起在临时目录，token/端口两边对不上。
 * 注意语义差异：本函数返回的已是 .loop-agent 目录本身，而非用户主目录。
 */
export function defaultAgentDir(): string {
  const override = process.env.LOOP_AGENT_HOME;
  if (override !== undefined && override.trim() !== '') return override.trim();
  return join(homedir(), '.loop-agent');
}

/**
 * 读 .loop-agent/config.json 的壳所需字段。
 *
 * 刻意不复用主工程 ConfigLoader：壳打包后只有自己的代码，且只需 port/token 两项。
 * 读不到或格式异常一律回落默认值，不因配置问题阻断启动。
 */
export function readShellConfig(agentDir: string = defaultAgentDir()): ShellConfig {
  const cfgPath = join(agentDir, 'config.json');
  try {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
      api?: { port?: unknown; token?: unknown };
      memory?: { dreaming?: { shutdownBudgetMs?: unknown } };
    };
    const port = Number(raw?.api?.port);
    const token = typeof raw?.api?.token === 'string' ? raw.api.token.trim() : '';
    const budget = Number(raw?.memory?.dreaming?.shutdownBudgetMs);
    return {
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
      token,
      // 预算必须是正数：0 或负数会让等待上限只剩宽限，等于直接强杀
      shutdownBudgetMs:
        Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_SHUTDOWN_BUDGET_MS,
    };
  } catch {
    return {
      port: DEFAULT_PORT,
      token: '',
      shutdownBudgetMs: DEFAULT_SHUTDOWN_BUDGET_MS,
    };
  }
}
