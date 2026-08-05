// 本地命令执行工具：执行 shell 命令，返回 stdout+stderr
import { exec } from 'node:child_process';
import type { Tool } from '../types.js';

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
  async execute(args) {
    const cmd = String(args.command);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const timeout = Number(args.timeout ?? 30000);

    return new Promise((resolve) => {
      exec(
        cmd,
        { cwd, timeout, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          const parts: string[] = [];
          if (stdout) parts.push(`[stdout]\n${stdout}`);
          if (stderr) parts.push(`[stderr]\n${stderr}`);
          if (err) {
            parts.push(`[exit=${err.code ?? '?'}] ${err.message}`);
          }
          resolve(parts.join('\n') || '(无输出)');
        },
      );
    });
  },
};
