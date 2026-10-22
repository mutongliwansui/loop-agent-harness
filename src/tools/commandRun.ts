// 本地命令执行工具：执行 shell 命令，返回 stdout+stderr
// Task-20261021-002-01：接入取消信号（exec signal）+ Windows 进程树兜底终止
// Task-20261022-002（需求 20261021-006）：新增 background 分支——spawn detached
// 立即返回 taskId，stdout/stderr 重定向到 ~/.loop-agent/runs/{taskId}.log，不受 runner 超时约束（D5）
import { exec, spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { killProcessTree } from './process-tree.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';
import { backgroundTasks, newTaskId, runsDir } from './background-tasks.js';

export const commandRun: Tool = {
  name: 'commandRun',
  description:
    '在本地执行 shell 命令，返回 stdout 与 stderr。用于查看目录、运行脚本、查询系统信息等。'
    + '长任务（dev server、watch、长测试）传 background:true 后台运行：立即返回 taskId，'
    + '随后用 commandStatus 查状态、commandLogs 增量读日志、commandStop 终止。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '工作目录（可选），默认当前目录' },
      timeout: { type: 'number', description: '超时毫秒数（可选），默认 30000（仅前台模式生效）' },
      background: {
        type: 'boolean',
        description:
          '后台运行模式（可选）：true 时立即返回 {taskId,pid,logPath}，不阻塞会话、不受 30s 超时限制。'
          + '适合 dev server/watch/长测试。后续用 commandStatus/commandLogs/commandStop 管理',
      },
    },
    required: ['command'],
  },
  async execute(args, ctx?: ToolContext) {
    const cmd = String(args.command);
    // 空间根（D3）：无 args.cwd 时显式落在注入根（原先靠 exec 的隐式 process.cwd()）；
    // 相对 args.cwd 按空间根展开，绝对路径原样放行（D20）
    const wsRoot = toolWorkspaceRoot(ctx);
    const cwd = args.cwd ? resolveToolPath(wsRoot, String(args.cwd)) : wsRoot;

    // ===== 后台分支（Task-20261022-002，D5/D9）：spawn 后秒回 =====
    if (args.background === true) {
      return runInBackground(cmd, cwd, ctx);
    }

    // ===== 前台路径：行为与现状完全一致 =====
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
          if (stderr) parts.push(`[stderr]\n[stderr]\n${stderr}`);
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

/**
 * 后台启动（D9）：spawn shell 子进程，stdout/stderr 追加写入任务日志文件
 *
 * - POSIX detached:true 使子进程成进程组长，killProcessTree 负 pid 杀组才有效；
 *   Windows 不 detached（靠 taskkill /T 树杀，detached 在 win32 语义不同）
 * - stdin ignore：后台任务不应等待输入（防悬挂）
 * - exit 回调注册任务表 finish（进程退出即更新状态与退出码，无需轮询）
 */
function runInBackground(cmd: string, cwd: string, ctx?: ToolContext): Promise<string> {
  return new Promise((resolve) => {
    const taskId = newTaskId();
    const logPath = join(runsDir(), `${taskId}.log`);
    try {
      mkdirSync(runsDir(), { recursive: true });
    } catch (e) {
      resolve(`工具执行失败: runs 目录不可写 (${e instanceof Error ? e.message : String(e)})`);
      return;
    }

    let logFd: number;
    try {
      logFd = openSync(logPath, 'a');
    } catch (e) {
      resolve(`工具执行失败: 日志文件创建失败 (${e instanceof Error ? e.message : String(e)})`);
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        shell: true,
        // POSIX detached 成进程组长（killProcessTree 负 pid 杀组）；Windows 靠 taskkill /T
        detached: process.platform !== 'win32',
        stdio: ['ignore', logFd, logFd],
        cwd,
        windowsHide: true,
        // 会话取消不连带终止后台任务（D10）：不把 ctx.signal 传给 spawn；
        // 用户显式 commandStop 才杀
      });
    } catch (e) {
      closeSync(logFd);
      resolve(`工具执行失败: 后台启动失败 (${e instanceof Error ? e.message : String(e)})`);
      return;
    }

    const task = backgroundTasks.start({
      taskId,
      pid: child.pid,
      command: cmd,
      cwd,
      logPath,
      startedAt: Date.now(),
    });

    // exit 回调：killed 状态先置时尊重 D8（finish 只对 running 生效）；
    // closeLog 防重入：error 与 exit 事件可能都触发，重复 closeSync 会抛 EBADF
    let fdClosed = false;
    const closeLog = (): void => {
      if (fdClosed) return;
      fdClosed = true;
      try { closeSync(logFd); } catch { /* 已关闭，忽略 */ }
    };
    child.on('exit', (code, signalName) => {
      closeLog();
      backgroundTasks.finish(task.taskId, signalName !== null ? null : (code ?? null));
    });
    // spawn 同步失败（命令解析层错误）：立即终态，返回错误文本
    child.on('error', (err) => {
      closeLog();
      backgroundTasks.finish(task.taskId, null);
      resolve(`工具执行失败: 后台启动失败 (${err.message})，taskId=${task.taskId} 已记录`);
    });

    // 成功路径立即返回（execute 秒回 → runner withTimeout 不可能超时，D5）
    resolve(
      JSON.stringify({
        taskId: task.taskId,
        pid: child.pid ?? null,
        logPath,
        hint: '用 commandStatus({taskId}) 查询状态；commandLogs({taskId}) 增量读日志；commandStop({taskId}) 终止',
      }),
    );
  });
}
