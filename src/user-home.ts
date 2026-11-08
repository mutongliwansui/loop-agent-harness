// 统一的用户级数据目录解析（~/.loop-agent）
//
// 背景：src 中 session/runs/logs/memory/uploads 等默认路径此前散落各处直接 join(homedir(), '.loop-agent')，
// 测试未显式注入 userDir 时会写入真实用户目录，长期运行堆积大量测试会话与后台任务文件。
// 本模块提供唯一入口 loopAgentHome()，并支持 LOOP_AGENT_HOME 环境变量重定向：
// - 测试隔离：vitest setupFiles 注入一次性临时目录，测试产物全部落在临时目录，进程退出自动删除；
// - 多实例/便携场景：可为不同实例指定独立数据目录。
//
// 纪律：新增需要写用户目录的模块一律 import 本函数，禁止直接 join(homedir(), '.loop-agent')。
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 用户级数据根目录（~/.loop-agent）。
 * 优先级：LOOP_AGENT_HOME 环境变量（测试隔离/多实例）> 真实用户主目录。
 * 返回值即 .loop-agent 目录本身（各模块在其下拼 sessions/runs/logs 等子目录）。
 */
export function loopAgentHome(): string {
  const override = process.env.LOOP_AGENT_HOME;
  if (override !== undefined && override.trim() !== '') return override.trim();
  return join(homedir(), '.loop-agent');
}
