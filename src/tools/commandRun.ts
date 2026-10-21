// 本地命令执行工具：执行 shell 命令，返回 stdout+stderr
// Task-20261021-002-01：接入取消信号（exec signal）+ Windows 进程树兜底终止
import { exec } from 'node:child_process';
import type { Tool, ToolContext } from '../types.js';
import { killProcessTree } from './process-tree.js';

export const commandRun: Tool = {
  name: 'commandRun',
  description:
    '在本地执行 shell 命令，返回 stdout 与 stderr。用于查看目录、运行脚本、查询系统信息等。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '工作目录（可选），默认当前目录' },
      timeout: { type: 'number', description: '超时毫秒数（可选），默认 30000' },
    },
    required: ['command'],
  },
  async execute(args, ctx?: ToolContext) {
    const cmd = String(args.command);
    // workspaceRoot 为 2b 接口位，本期不消费（默认仍为 exec 的 process.cwd()）
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const timeout = Number(args.timeout ?? 30000);

    return new Promise((resolve) => {
      const child = exec(
        cmd,
        { cwd, timeout, maxBuffer: 1024 * 1024, signal: ctx?.signal },
        (err, stdout, stderr) => {
          // abort 触发的 err（ExecException, killed=true）也走同一汇编，
          // 该返回值会被 ToolRunner.raceAbort 的 reject 丢弃，无需特判
          const parts: string[] = [];
          if (stdout) parts.push(`[stdout]\n${stdout}`);
          if (stderr) parts.push(`[stderr]\n${stderr}`);
          if (err) {
            parts.push(`[exit=${err.code ?? '?'}] ${err.message}`);
          }
          resolve(parts.join('\n') || '(无输出)');
        },
      );
      // Windows：exec 走 cmd.exe，signal 只能杀 shell 本身，孙进程会残留
      // → 趁进程树完整时用 taskkill /T /F 兜底（先杀直接子进程会让后代孤儿化）
      ctx?.signal?.addEventListener(
        'abort',
        () => { void killProcessTree(child.pid); },
        { once: true },
      );
    });
  },
};
