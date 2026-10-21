// POST /sessions/:id/messages：发消息（D3 默认 SSE 流式，stream:false 切非流式 JSON）

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendError, sendJson } from '../http-utils.js';
import { createSseForwarder, sseFrame } from '../sse.js';
import type { AgentOptions } from '../../types.js';
import { switchWorkspace } from './sessions.js';

export async function handleMessage(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const { deps, sessions, log } = ctx;
  const body = await readJsonBody(req);
  const message = body.message;
  if (typeof message !== 'string' || !message.trim()) {
    throw new ApiHttpError('bad_request', 'message 必须为非空字符串');
  }
  const stream = body.stream !== false; // 默认 true

  // 跨工作空间会话：自动切换到会话所在空间再对话（查看时 GET 详情已先行切换；此处兜底直接发消息的入口）
  if (!(await deps.sessionStore.listSessions()).some((s) => s.id === id)) {
    const foreign = (await deps.sessionStore.listAllWorkspaces()).find(
      (w) => !w.current && w.sessions.some((s) => s.id === id),
    );
    if (foreign) {
      if (sessions.hasInFlight()) {
        throw new ApiHttpError('busy', '存在正在处理的会话，暂不能切换工作空间');
      }
      await switchWorkspace(ctx, foreign.path);
    }
  }

  const entry = await sessions.ensureEntry(id);
  if (entry.inFlight) {
    throw new ApiHttpError('busy', `会话 ${id} 正在处理上一条消息，请稍后再试`);
  }

  const startedAt = Date.now();
  const warnings: string[] = []; // 持久化失败降级收集（不失败请求）
  // run 注册（流式/非流式一致）：/workspaces 运行中标记、GET /sessions/:id 的 run、attach 端点均据此判断
  ctx.runs.start(id);

  // D5：空历史 → resetHistory（忽略 agent 实例残留 _chatHistory）；非空 → 显式 messages
  const historyBefore = entry.history;
  const runOptions: AgentOptions = {
    verbose: false,
    ...(historyBefore.length === 0
      ? { resetHistory: true }
      : { messages: [...historyBefore] }),
  };

  // 节流落盘：run 过程中每 3 次迭代或 30s 快照一次（压缩前强制），
  // 进程中途退出时也能保留已产生的工具调用与结果。失败只记日志，不影响回答。
  runOptions.onSnapshot = async (snapshot) => {
    try {
      await deps.sessionStore.updateSession(id, snapshot.messages, message, {
        transcript: snapshot.transcript,
      });
    } catch (e) {
      log(
        `[api] 会话 ${id} 节流落盘失败（不阻塞回答）: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let clientGone = false;
    let unsubscribe = (): void => {};
    res.on('close', () => {
      clientGone = true; // 停止写流，但 run 照常完成并持久化
      unsubscribe();
    });
    // 本连接作为 RunHub 的首个订阅者（cursor=0 → 全量回放；此刻尚无事件）
    const sub = ctx.runs.subscribe(id, 0, (ev) => {
      if (!clientGone) sseFrame(res, ev.event, ev.data, ev.seq);
    });
    unsubscribe = sub?.unsubscribe ?? ((): void => {});
    // Agent 事件先入 Hub（供断线续传），再由 Hub fan-out 到当前连接
    runOptions.events = [createSseForwarder((event, data) => void ctx.runs.publish(id, event, data))];
  }

  entry.inFlight = (async () => {
    try {
      const result = await deps.runAgent(message, runOptions);

      // 持久化（API 层自持 SessionStore；会话已在 ensureEntry/loadSession 阶段确认存在）
      try {
        // 显式传原始输入供会话标题生成（messages 可能已被 L1 压缩重写，不可靠）；
        // transcript 为未经压缩的完整轨迹：压缩轮次据此归档「已被压缩、从未落盘」的消息。
        // 用 store 归一化后的会话消息作为 entry.history（摘要占位已转写为总结消息、压缩标记一致）。
        // 同时剔除 is_compact=true 的已折叠历史：与 ensureEntry 的 getRestoreMessages 恢复视图对齐，
        // 避免折叠历史重新进入 LLM 上下文并导致每轮重复触发压缩
        const stored = await deps.sessionStore.updateSession(id, result.messages, message, {
          transcript: result.transcript,
        });
        entry.history = stored.filter((m) => m.role !== 'system' && m.is_compact !== true);
      } catch (e) {
        warnings.push(`会话持久化失败（回答不受影响）: ${e instanceof Error ? e.message : String(e)}`);
        entry.history = result.messages.filter((m) => m.role !== 'system' && m.is_compact !== true);
      }

      const donePayload = {
        sessionId: id,
        durationMs: Date.now() - startedAt,
        iterations: result.iterations,
        steps: result.steps.length,
      };
      // 终态统一经 Hub 发布（断线重连可回放）：warnings 先于 done
      for (const w of warnings) {
        ctx.runs.publish(id, 'warning', { level: 'warning', message: w });
      }
      ctx.runs.finish(id, 'done', { event: 'done', data: donePayload });
      if (stream) {
        res.end();
      } else {
        sendJson(res, 200, {
          sessionId: id,
          answer: result.answer,
          iterations: result.iterations,
          steps: result.steps,
          durationMs: donePayload.durationMs,
          ...(warnings.length ? { warnings } : {}),
        });
      }
      log(`[api] 会话 ${id} 完成: ${result.iterations} 轮 / ${result.steps.length} 步 / ${donePayload.durationMs}ms`);
    } catch (e) {
      // run 抛错：流式先推已发生事件再合成 fatal 关流；非流式 500（失败轮不持久化，保留原历史）
      const msg = e instanceof Error ? e.message : String(e);
      log(`[api] 会话 ${id} 运行失败: ${msg}`);
      ctx.runs.finish(id, 'failed', { event: 'fatal', data: { message: msg } });
      if (stream) {
        res.end();
      } else {
        sendError(res, 'internal', msg);
      }
    } finally {
      entry.inFlight = null;
    }
  })();

  await entry.inFlight;
}
