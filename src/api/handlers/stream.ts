// GET /sessions/:id/stream?cursor=N：附着到会话当前（或刚结束）的 run 并续传事件
//
// 与 GET /sessions/:id 的区别：只读、不触发跨工作空间切换、不返回历史（历史由前端单独拉取）；
// - 无 run（从未运行 / 已过保留期）→ 204，前端保持快照展示
// - cursor 落后到缓冲已丢弃 → 先发 reset 事件，再回放仍保留的部分
// - run 已结束 → 回放终态后直接关流
// - 运行中 → 回放后续传实时事件，15s keep-alive 注释帧保活

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { sseFrame } from '../sse.js';

/** keep-alive 注释帧间隔（防中间层 idle 超时断流） */
const KEEP_ALIVE_MS = 15_000;

export async function handleAttachStream(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  // 只读校验：跨空间会话也可附着（run 只可能存在于其所属空间），但不切换当前空间
  const exists = (await ctx.deps.sessionStore.listAllWorkspaces()).some((w) =>
    w.sessions.some((s) => s.id === id),
  );
  if (!exists) throw new ApiHttpError('not_found', `会话不存在: ${id}`);

  if (!ctx.runs.snapshot(id)) {
    res.writeHead(204);
    res.end();
    return;
  }

  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const parsed = Number.parseInt(query.get('cursor') ?? '0', 10);
  let cursor = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let closed = false;
  let unsubscribe = (): void => {};
  const keepAlive = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, KEEP_ALIVE_MS);
  keepAlive.unref?.();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
  };
  res.on('close', cleanup);

  if (ctx.runs.isCursorStale(id, cursor)) {
    const oldestSeq = ctx.runs.oldestSeq(id);
    if (!closed) sseFrame(res, 'reset', { reason: 'buffer_overflow', oldestSeq });
    cursor = oldestSeq - 1;
  }

  const sub = ctx.runs.subscribe(id, cursor, (ev) => {
    if (closed) return;
    sseFrame(res, ev.event, ev.data, ev.seq);
    if (ev.event === 'done' || ev.event === 'fatal') {
      res.end(); // 终态后关流，前端据 lastSeq 判定无需再附着
      cleanup();
    }
  });
  if (!sub) {
    // snapshot 与 subscribe 之间无 await，正常不可达；保守关流避免悬挂
    res.end();
    cleanup();
    return;
  }
  unsubscribe = sub.unsubscribe;
  if (sub.finished) {
    res.end();
    cleanup();
  }
}
