/**
 * 用户级数据根目录（`~/.loop-agent`）。
 *
 * 与主工程 `src/user-home.ts` 同语义，但**独立实现**（设计决策 D12）：
 * main 要能作为独立包演进与发布，import 主工程 `src/` 会破坏
 * 「零反向依赖」边界；反过来 core 也绝不 import main。
 *
 * 优先级：`LOOP_AGENT_HOME` 环境变量（测试隔离 / 多实例）> 真实用户主目录。
 * 惰性求值（每次调用都读一遍环境变量），以便测试在用例内重定向。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function loopAgentHome(): string {
  const override = process.env.LOOP_AGENT_HOME;
  if (override !== undefined && override.trim() !== '') return override.trim();
  return join(homedir(), '.loop-agent');
}

/**
 * 插件目录（`~/.loop-agent/plugins`）。
 *
 * 注意它读环境变量而非某个已注入的 home：调用方若需要与自定义 home
 * 联动，请用 `join(home, 'plugins')` 自行计算（`createMainHost` 即如此）。
 */
export function pluginsDir(): string {
  return join(loopAgentHome(), 'plugins');
}
