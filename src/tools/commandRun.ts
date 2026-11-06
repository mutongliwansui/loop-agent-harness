// 本地命令执行工具：执行 shell 命令，返回 stdout+stderr
// Task-20261021-002-01：接入取消信号 + Windows 进程树兜底终止
// Task-20261022-002（需求 20261021-006）：新增 background 分支——spawn detached
// 立即返回 taskId，stdout/stderr 重定向到 ~/.loop-agent/runs/{taskId}.log，不受 runner 超时约束（D5）
// 需求 20261104-006：前台改 spawn + 头尾累积器，移除 maxBuffer 上限，修正 stderr 重复标签
// 需求 20261106-001：前台 stdout/stderr 分两路消费——
//   一路 OutputAccumulator（头尾截断进上下文），一路 TmpFileWriter（完整流式写临时文件，超限才创建，小输出零磁盘开销）
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
import {
  TmpFileWriter,
  buildFullOutputNotice,
  summarizeParam,
  pruneTmp,
} from './output-governor.js';

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

    // ===== 前台路径（需求 20261104-006 / 20261106-001）：
    // spawn 流式捕获 + 头尾截断 + 超限完整输出落临时文件
    const outOpts = commandRunOutputOptions();
    const timeout = Number(args.timeout ?? outOpts.timeoutMs);
    // 需求 20261106-001：启动前先清理过期临时文件（与 backgroundTasks.pruneRuns 同口径）
    try { pruneTmp(); } catch { /* ignore */ }
    return runInForeground(cmd, cwd, timeout, ctx);
  },
};

/**
 * 前台执行（需求 20261104-006 D1/D3/D4/D8 + 20261106-001 D1/D2/D3/D5）：
 * - spawn(shell) 持续消费 stdout/stderr，超限只丢弃中段（不再因 maxBuffer 失败）
 * - 超时 / ctx.signal 取消都走 killProcessTree 树杀（Windows 防孙进程残留）
 * - 输出标签稳定：`[stdout]` / `[stderr]` / `[exit=N]` / `[timeout=…]` / `[aborted]` / `[signal=…]`
 *
 * 20261106-001 新增：
 * - stdout/stderr 分两路消费：一路 OutputAccumulator（头尾截断进上下文），
 *   一路 TmpFileWriter（完整流式写临时文件，累计达 triggerMultiplier × preserveKb 才创建 WriteStream，
 *   小输出零磁盘 I/O）
 * - finalize 后若完整文件存在，在 observation 末尾追加结构化路径提示供 LLM 按需分段再读
 */
function runInForeground(cmd: string, cwd: string, timeout: number, ctx?: ToolContext): Promise<string> {
  // 已取消：不启动进程，立即收敛（既有 abort 用例依赖「不悬挂」）
  if (ctx?.signal?.aborted) return Promise.resolve('[aborted]');

  const { headBytes, tailBytes } = outputQuotas(commandRunOutputOptions().outputLimitKb);
  const out = new OutputAccumulator(headBytes, tailBytes);
  const err = new OutputAccumulator(headBytes, tailBytes);

  // 需求 20261106-001：超限治理器（小输出零磁盘开销，累计超阈值才创建 WriteStream）
  const digest = summarizeParam({ command: cmd }, 'commandRun');
  const tmpWriter = new TmpFileWriter({
    sessionId: ctx?.sessionId,
    toolName: 'commandRun',
    paramDigest: digest,
  });

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const finish = async (code: number | null, signalName: string | null, spawnError?: string): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (onAbort) ctx?.signal?.removeEventListener('abort', onAbort);

      // 需求 20261106-001：等待 TmpFileWriter drain + close
      let fullInfo: Awaited<ReturnType<typeof tmpWriter.finalize>> | undefined;
      try {
        fullInfo = await tmpWriter.finalize();
      } catch { /* 临时文件关闭异常不阻塞主输出 */ }

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

      if (timedOut || aborted || signalName || (code !== null && code !== 0)) {
        parts.push(`[duration=${durationMs}ms]`);
      }

      // 需求 20261106-001：如果完整输出已落临时文件，追加结构化提示
      if (fullInfo) {
        const suggestion = '建议: 完整输出已保存，可按需用 fileRead 的 startLine/endLine 分段读取，如 startLine: 1, endLine: 2000；或先用 grep 定位关键内容';
        parts.push(buildFullOutputNotice({
          path: fullInfo.path,
          bytes: fullInfo.bytes,
          lines: fullInfo.lines,
          suggestion,
        }));
      }

      resolve(parts.length > 0 ? parts.join('\n') : '(无输出，exit=0)');
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
      void finish(null, null, e instanceof Error ? e.message : String(e));
      return;
    }

    // 需求 20261106-001：分两路并行消费（不能先 pipe 到累积器再 pipe 到文件，
    // 第一个 pipe 会消费 buffer，第二个拿不到；用两个 on('data') 分支）
    child.stdout?.on('data', (chunk: Buffer) => {
      out.push(chunk);
      tmpWriter.onChunk(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err.push(chunk);
      tmpWriter.onChunk(chunk);
    });

    const kill = (): void => {
      if (child.pid) void killProcessTree(child.pid);
      // 树杀失败/事件延迟兜底：2s 后强制收敛，避免 Promise 悬挂
      if (!forceTimer) {
        forceTimer = setTimeout(() => void finish(null, null), 2000);
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

    child.on('error', (e) => void finish(null, null, e.message));
    child.on('close', (code, signalName) => void finish(code, signalName));
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
