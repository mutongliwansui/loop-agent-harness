// POST /sessions/:id/messages：发消息（D3 默认 SSE 流式，stream:false 切非流式 JSON）

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendError, sendJson } from '../http-utils.js';
import { createSseForwarder, sseFrame } from '../sse.js';
import type { AgentOptions } from '../../types.js';

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

  // 跨工作空间会话只读：仅当前空间的会话可继续对话（架构上一个 serve 进程只服务一个工作空间）
  if (!(await deps.sessionStore.listSessions()).some((s) => s.id === id)) {
    const foreign = (await deps.sessionStore.listAllWorkspaces()).some(
      (w) => !w.current && w.sessions.some((s) => s.id === id),
    );
    if (foreign) {
      throw new ApiHttpError('readonly', '跨工作空间会话仅支持查看与删除，不支持继续对话');
    }
  }

  const entry = await sessions.ensureEntry(id);
  if (entry.inFlight) {
    throw new ApiHttpError('busy', `会话 ${id} 正在处理上一条消息，请稍后再试`);
  }

  const startedAt = Date.now();
  const warnings: string[] = []; // 持久化失败降级收集（不失败请求）

  // D5：空历史 → resetHistory（忽略 agent 实例残留 _chatHistory）；非空 → 显式 messages
  const historyBefore = entry.history;
  const runOptions: AgentOptions = {
    verbose: false,
    ...(historyBefore.length === 0
      ? { resetHistory: true }
      : { messages: [...historyBefore] }),
  };

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let clientGone = false;
    res.on('close', () => {
      clientGone = true; // 停止写流，但 run 照常完成并持久化
    });
    const forwarder = createSseForwarder((event, data) => {
      if (!clientGone) sseFrame(res, event, data);
    });
    runOptions.events = [forwarder];
  }

  entry.inFlight = (async () => {
    try {
      const result = await deps.runAgent(message, runOptions);

      // 持久化（API 层自持 SessionStore；会话已在 ensureEntry/loadSession 阶段确认存在）
      try {
        await deps.sessionStore.updateSession(id, result.messages, result.steps);
      } catch (e) {
        warnings.push(`会话持久化失败（回答不受影响）: ${e instanceof Error ? e.message : String(e)}`);
      }
      entry.history = result.messages.filter((m) => m.role !== 'system');

      const donePayload = {
        sessionId: id,
        durationMs: Date.now() - startedAt,
        iterations: result.iterations,
        steps: result.steps.length,
      };
      if (stream) {
        for (const w of warnings) sseFrame(res, 'warning', { level: 'warning', message: w });
        sseFrame(res, 'done', donePayload); // D4 合成终态：正常结束
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
      if (stream) {
        sseFrame(res, 'fatal', { message: msg }); // D4 合成终态：异常
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
