// POST /sessions/:id/messages：发消息（D3 默认 SSE 流式，stream:false 切非流式 JSON）

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendError, sendJson } from '../http-utils.js';
import { createSseForwarder, sseFrame } from '../sse.js';
import type { AgentOptions } from '../../types.js';
import { AgentAbortedError } from '../../types.js';
import { sealPendingToolCalls } from '../abort-utils.js';
import { currentBootId, writeJournal, writeRunLog } from '../run-journal.js';
import { locateSession } from '../session-locator.js';
import { markWorkspaceUsed } from '../recent-workspace.js';

export async function handleMessage(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const { deps, log } = ctx;
  const body = await readJsonBody(req);
  const message = body.message;
  if (typeof message !== 'string' || !message.trim()) {
    throw new ApiHttpError('bad_request', 'message 必须为非空字符串');
  }
  const stream = body.stream !== false; // 默认 true

  // Task-20261021-010-04（D10/D17）：按 sessionId 定位归属 runtime，
  // 在该空间的 sessions/store/runAgent 内完成读历史、互斥与执行——
  // 不再切换全局"当前空间"，跨空间会话续聊天然并行（per-space 互斥仅作用于归属空间）
  let sessions = ctx.sessions;
  let store = deps.sessionStore;
  let runAgent = deps.runAgent;
  if (ctx.registry) {
    const rt = await locateSession(ctx.registry, id);
    sessions = rt.sessions;
    store = rt.store;
    runAgent = (sessionId, input, options) => rt.runAgent(sessionId, input, options);
    // 需求 20261027-004：活跃对话刷新「最近使用空间」指针（缺省空间语义的事实源）
    markWorkspaceUsed(rt.root);
  }

  const entry = await sessions.ensureEntry(id);
  if (entry.inFlight) {
    throw new ApiHttpError('busy', `会话 ${id} 正在处理上一条消息，请稍后再试`);
  }

  const startedAt = Date.now();
  const warnings: string[] = []; // 持久化失败降级收集（不失败请求）
  // run 注册（流式/非流式一致）：/workspaces 运行中标记、GET /sessions/:id 的 run、attach 端点均据此判断
  ctx.runs.start(id);
  // journal 落盘（Task-20261021-002-06）：run 开始即写 running 记录 + 诊断日志（best-effort，失败静默）
  const runIdNow = ctx.runs.snapshot(id)?.runId ?? '';
  void writeJournal(store, id, {
    runId: runIdNow,
    sessionId: id,
    status: 'running',
    startedAt,
    pid: process.pid,
    bootId: currentBootId(),
  });
  void writeRunLog({
    ts: new Date().toISOString(),
    sessionId: id,
    runId: runIdNow,
    event: 'start',
  });

  // D5：空历史 → resetHistory（忽略 agent 实例残留 _chatHistory）；非空 → 显式 messages
  const historyBefore = entry.history;
  const runOptions: AgentOptions = {
    verbose: false,
    ...(historyBefore.length === 0
      ? { resetHistory: true }
      : { messages: [...historyBefore] }),
  };

  // ===== 会话级模型覆盖（task-20261025-002 D4/D11）=====
  // 只作用于本次 run，绝不写盘改全局激活（不用 PUT /model）；
  // 有值但不存在/无 key 时明确报错，不静默回落——静默回落会让人「以为换了其实没换」。
  const modelAliasRaw = typeof body.modelAlias === 'string' ? body.modelAlias.trim() : '';
  if (modelAliasRaw) {
    const { config: cfg } = ctx.configLoader.load();
    const profile = cfg.models.profiles[modelAliasRaw];
    if (!profile) {
      const known = Object.keys(cfg.models.profiles).sort().join('、') || '（空）';
      throw new ApiHttpError(
        'bad_request',
        `未找到模型「${modelAliasRaw}」。已登记: ${known}`,
      );
    }
    if (!profile.apiKey) {
      throw new ApiHttpError(
        'bad_request',
        `profile「${modelAliasRaw}」未配置 apiKey，无法用于本次对话（可用 PUT /config/models.profiles.${modelAliasRaw}.apiKey 补充）`,
      );
    }
    runOptions.model = profile.name;
    runOptions.baseUrl = profile.baseUrl;
    runOptions.apiKey = profile.apiKey;
    if (profile.temperature !== undefined) runOptions.temperature = profile.temperature;

    // 兜底落盘（D7）：前端在「新建会话还没 id」时选了模型 → selectModel 的 PUT 无处可写，
    // 此处补写一次，保证重进会话能还原。best-effort，失败不影响本轮对话。
    void (async () => {
      try {
        const meta = (await store.listSessions()).find((s) => s.id === id);
        if (meta && meta.modelAlias !== modelAliasRaw) {
          await store.setSessionModelAlias(id, modelAliasRaw);
        }
      } catch (e) {
        log(`[api] 会话 ${id} 模型选择落盘失败（不影响回答）: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }

  // 取消链路（Task-20261021-002-03 D8）：signal 取自 RunHub（start 之后取），
  // 生命周期与 run 注册同源——/stop 触发 abort 时 agent 主循环感知并抛 AgentAbortedError
  runOptions.signal = ctx.runs.signal(id) ?? undefined;

  // 节流落盘：run 过程中每 3 次迭代或 30s 快照一次（压缩前强制），
  // 进程中途退出时也能保留已产生的工具调用与结果。失败只记日志，不影响回答。
  runOptions.onSnapshot = async (snapshot) => {
    try {
      await store.updateSession(id, snapshot.messages, message, {
        transcript: snapshot.transcript,
      });
      // journal 同步（best-effort）：迭代数随节流窗口合并落盘（500ms 窗口，D3 不追求精确）
      void writeJournal(store, id, { iterations: snapshot.iterations });
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
    // Agent 事件先入 Hub（供断线续传），再由 Hub fan-out 到当前连接；
    // 发布返回的 seq 顺带同步 journal lastSeq（节流写，仅供中断诊断）
    runOptions.events = [
      createSseForwarder((event, data) => {
        const seq = ctx.runs.publish(id, event, data);
        if (seq > 0) void writeJournal(store, id, { lastSeq: seq });
      }),
    ];
  }

  entry.inFlight = (async () => {
    try {
      // 05：sessionId 首参 → AgentPool 按会话租用独立实例（同空间多会话并发）
      const result = await runAgent(id, message, runOptions);

      // 持久化（API 层自持 SessionStore；会话已在 ensureEntry/loadSession 阶段确认存在）
      try {
        // 显式传原始输入供会话标题生成（messages 可能已被 L1 压缩重写，不可靠）；
        // transcript 为未经压缩的完整轨迹：压缩轮次据此归档「已被压缩、从未落盘」的消息。
        // 用 store 归一化后的会话消息作为 entry.history（摘要占位已转写为总结消息、压缩标记一致）。
        // 同时剔除 is_compact=true 的已折叠历史：与 ensureEntry 的 getRestoreMessages 恢复视图对齐，
        // 避免折叠历史重新进入 LLM 上下文并导致每轮重复触发压缩
        const stored = await store.updateSession(id, result.messages, message, {
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
      // journal 终态 + 诊断日志（best-effort）
      void writeJournal(store, id, {
        status: 'done',
        finishedAt: Date.now(),
        iterations: result.iterations,
      });
      void writeRunLog({
        ts: new Date().toISOString(),
        sessionId: id,
        runId: runIdNow,
        event: 'finish',
        status: 'done',
        durationMs: donePayload.durationMs,
        iterations: result.iterations,
      });
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
      // ===== 用户取消收尾（Task-20261021-002-03） =====
      // agent 主循环感知 abort 后抛 AgentAbortedError（partial 含完整快照）：
      // 封口（补齐孤立 tool_calls）→ 部分落盘（失败降级 warning）→ warning + aborted 终态 → 响应。
      // D4：中断标记不进消息数组；D6：aborted 终态带 partial:true，前端渲染部分输出灰条而非失败态；
      // D7：非流式返回 200（用户主动行为不算错误）。
      if ((e as { aborted?: boolean }).aborted === true && e instanceof AgentAbortedError) {
        const partial = e.partial;
        const sealed = sealPendingToolCalls(partial.messages);
        const abortedWarnings: string[] = [];
        let stored = sealed;
        try {
          stored = await store.updateSession(id, sealed, message, {
            transcript: partial.transcript,
          });
        } catch (err) {
          abortedWarnings.push(
            `会话持久化失败（已停止，部分输出仅存内存）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // store 归一化后的消息作为 entry.history（与成功路径同一过滤口径）
        entry.history = stored.filter((m) => m.role !== 'system' && m.is_compact !== true);
        for (const w of abortedWarnings) {
          ctx.runs.publish(id, 'warning', { level: 'warning', message: w });
        }
        ctx.runs.publish(id, 'warning', {
          level: 'warning',
          message: '已被用户停止（以上为已生成的部分输出）',
        });
        ctx.runs.finish(id, 'aborted', {
          event: 'aborted',
          data: {
            sessionId: id,
            durationMs: Date.now() - startedAt,
            iterations: partial.iterations,
            steps: partial.steps.length,
            partial: true,
          },
        });
        // journal 终态 + 诊断日志（best-effort）：aborted 也属正常收尾，重启后显示「由用户停止」
        void writeJournal(store, id, {
          status: 'aborted',
          finishedAt: Date.now(),
          iterations: partial.iterations,
        });
        void writeRunLog({
          ts: new Date().toISOString(),
          sessionId: id,
          runId: runIdNow,
          event: 'abort',
          status: 'aborted',
          durationMs: Date.now() - startedAt,
          iterations: partial.iterations,
        });
        if (stream) {
          res.end();
        } else {
          sendJson(res, 200, {
            sessionId: id,
            aborted: true,
            partial: true,
            iterations: partial.iterations,
            steps: partial.steps.length,
            ...(abortedWarnings.length ? { warnings: abortedWarnings } : {}),
          });
        }
        log(`[api] 会话 ${id} 已被用户停止: ${partial.iterations} 轮 / ${partial.steps.length} 步（部分输出已落盘）`);
        return;
      }
      // run 抛错：流式先推已发生事件再合成 fatal 关流；非流式 500（失败轮不持久化，保留原历史）
      const msg = e instanceof Error ? e.message : String(e);
      log(`[api] 会话 ${id} 运行失败: ${msg}`);
      ctx.runs.finish(id, 'failed', { event: 'fatal', data: { message: msg } });
      // journal 终态 + 诊断日志（best-effort）
      void writeJournal(store, id, { status: 'failed', finishedAt: Date.now() });
      void writeRunLog({
        ts: new Date().toISOString(),
        sessionId: id,
        runId: runIdNow,
        event: 'failed',
        status: 'failed',
        durationMs: Date.now() - startedAt,
      });
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
