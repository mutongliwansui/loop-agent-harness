// 进程级启动参数 → 配置覆盖（优先级最高，见 ConfigLoader.load/loadAsync 的 cli 层）
//
// 恢复说明（Task-20261021-010-06）：本模块由 task-03 提交 c3363aa 引入 loader.ts 引用，
// 但文件本身从未入库、随后丢失，导致 HEAD 无法编译。按以下两处既有证据补齐契约：
//   1) loader.ts 注释「进程级启动参数（--port 等）优先级最高，且对所有 ConfigLoader 实例生效」
//   2) task-01 / task-03 完成记录的实机 smoke `--serve --port 3099` 生效
// 因此只覆盖 ApiConfig 的四个启动期字段，其它配置走工作空间/全局/.env 层级，不在此处发明。
//
// 书写形式：`--port 3099` 与 `--port=3099` 等价；缺值或非法值（非正整数端口）一律忽略，
// 回落到下一层配置（失败可见但不阻断启动，避免一个笔误让服务起不来）。

import type { PartialAgentConfig } from './schema.js';

/** 取 `--name value` / `--name=value` 的值；未出现返回 undefined */
function argValue(argv: string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === flag) {
      const next = argv[i + 1];
      // 下一个 token 仍是参数（或以 -- 开头）视为缺值
      return next && !next.startsWith('--') ? next : undefined;
    }
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

/** 端口：仅接受 1~65535 的整数，其余忽略 */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * 解析进程级启动参数为配置覆盖片段。
 *
 * 每次调用都重新解析（argv 是启动期常量，但单测会替换 `process.argv`，不做缓存以免读到旧值）。
 */
export function getCliOverrides(): PartialAgentConfig {
  const argv = process.argv.slice(2);

  const api: NonNullable<PartialAgentConfig['api']> = {};
  const port = parsePort(argValue(argv, 'port'));
  if (port !== undefined) api.port = port;
  const host = argValue(argv, 'host');
  if (host) api.host = host;
  const token = argValue(argv, 'token');
  if (token) api.token = token;
  const webRoot = argValue(argv, 'web-root');
  if (webRoot) api.webRoot = webRoot;

  return Object.keys(api).length > 0 ? { api } : {};
}
