// 本地命令执行工具：执行 shell 命令，返回 stdout+stderr
// Task-20261021-002-01：接入取消信号 + Windows 进程树兜底终止
// Task-20261022-002（需求 20261021-006）：新增 background 分支——spawn detached
// 立即返回 taskId，stdout/stderr 重定向到 ~/.loop-agent/runs/{taskId}.log，不受 runner 超时约束（D5）
// 需求 20261104-006：前台改 spawn + 头尾累积器，移除 maxBuffer 上限，修正 stderr 重复标签
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { killProcessTree } from './process-tree.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';
import { backgroundTasks, newTaskId, runsDir } from './background-tasks.js';
import {
  OutputAccumulator,
  commandRunOutputOptions,
  outputQuotas,
} from './command-run-output.js';

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

    // ===== 前台路径（需求 20261104-006）：spawn 流式捕获 + 头尾截断 =====
    const outOpts = commandRunOutputOptions();
    const timeout = Number(args.timeout ?? outOpts.timeoutMs);
    return runInForeground(cmd, cwd, timeout, ctx);
  },
};

/**
 * 前台执行（需求 20261104-006 D1/D3/D4/D8）：
 * - spawn(shell) 持续消费 stdout/stderr，超限只丢弃中段（不再因 maxBuffer 失败）
 * - 超时 / ctx.signal 取消都走 killProcessTree 树杀（Windows 防孙进程残留）
 * - 输出标签稳定：`[stdout]` / `[stderr]` / `[exit=N]` / `[timeout=…]` / `[aborted]` / `[signal=…]`
 */
function runInForeground(cmd: string, cwd: string, timeout: number, ctx?: ToolContext): Promise<string> {
  // 已取消：不启动进程，立即收敛（既有 abort 用例依赖「不悬挂」）
  if (ctx?.signal?.aborted) return Promise.resolve('[aborted]');

  const { headBytes, tailBytes } = outputQuotas(commandRunOutputOptions().outputLimitKb);
  const out = new OutputAccumulator(headBytes, tailBytes);
  const err = new OutputAccumulator(headBytes, tailBytes);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const finish = (code: number | null, signalName: string | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (onAbort) ctx?.signal?.removeEventListener('abort', onAbort);

      if (spawnError) {
        resolve(`工具执行失败: 启动失败 (${spawnError})`);
        return;
      }

      const stdoutText = out.render();
      const stderrText = err.render();
      const parts: string[] = [];
      if (stdoutText.text) parts.push(`[stdout]\n${stdoutText.text}`);
      if (stderrText.text) parts.push(`[stderr]\n${stderrText.text}`);

      const durationMs = Date.now() - startedAt;
      if (timedOut) parts.push(`[timeout=${timeout}ms]`);
      else if (aborted) parts.push('[aborted]');
      else if (signalName) parts.push(`[signal=${signalName}]`);
      else if (code !== null && code !== 0) parts.push(`[exit=${code}]`);

      if (parts.length > 0) {
        // 非正常结束附耗时，便于排障；正常成功保持旧版观感（仅修正 stderr 标签）
        if (timedOut || aborted || signalName || (code !== null && code !== 0)) {
          parts.push(`[duration=${durationMs}ms]`);
        }
        resolve(parts.join('\n'));
      } else {
        resolve('(无输出，exit=0)');
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      finish(null, null, e instanceof Error ? e.message : String(e));
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));

    const kill = (): void => {
      if (child.pid) void killProcessTree(child.pid);
      // 树杀失败/事件延迟兜底：2s 后强制收敛，避免 Promise 悬挂
      if (!forceTimer) {
        forceTimer = setTimeout(() => finish(null, null), 2000);
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    timer.unref?.();

    if (ctx?.signal) {
      onAbort = (): void => {
        aborted = true;
        kill();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signalName) => finish(code, signalName));
  });
}

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
      // 需求 20261104-003：后台启动前做一次轻量清理，避免长驻服务日志只增不减
      backgroundTasks.pruneRuns();
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
      // 需求 20261104-004 D5：归属会话，完成通知投递回原会话
      sessionId: ctx?.sessionId,
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
