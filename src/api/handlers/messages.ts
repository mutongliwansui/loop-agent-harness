// POST /sessions/:id/messages：发消息（D3 默认 SSE 流式，stream:false 切非流式 JSON）

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendError, sendJson } from '../http-utils.js';
import { createSseForwarder, sseFrame } from '../sse.js';
import type {
  AgentOptions,
  ChatMessage,
  LLMStats,
  LLMStatsSummary,
  SubAgentCompleteInfo,
  SubAgentTrace,
  TurnUsage,
} from '../../types.js';
import {
  AgentAbortedError,
  SUBAGENT_RESULT_CLOSE,
  SUBAGENT_RESULT_OPEN,
  isDisplayOnlyContent,
  isSubAgentResultContent,
} from '../../types.js';
import { applySubAgentEvent, createSubAgentTrace } from '../../agent/subagent-trace.js';
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
  const body = await readJsonBody(req);
  const message = body.message;
  if (typeof message !== 'string' || !message.trim()) {
    throw new ApiHttpError('bad_request', 'message 必须为非空字符串');
  }
  const stream = body.stream !== false; // 默认 true
  const modelAliasRaw = typeof body.modelAlias === 'string' ? body.modelAlias.trim() : '';
  await runMessageTurn(ctx, res, id, message, stream, modelAliasRaw);
}

/**
 * 启动一轮对话并通过 SSE/JSON 返回结果（需求 20261106-005 P1：重试复用此公共段）。
 *
 * 调用方负责：会话存在性、`inFlight` 互斥、重试时的历史截断。
 */
export async function runMessageTurn(
  ctx: HandlerContext,
  res: ServerResponse,
  id: string,
  message: string,
  stream: boolean,
  modelAliasRaw: string,
): Promise<void> {
  const { deps, log } = ctx;

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
    // A（task-20261106-002 D1）：本次 run 的会话身份真源，贯穿记忆读写与工具 ctx
    sessionId: id,
    verbose: false,
    ...(historyBefore.length === 0
      ? { resetHistory: true }
      : { messages: [...historyBefore] }),
  };

  // ===== 会话级模型覆盖（task-20261025-002 D4/D11）=====
  // 只作用于本次 run，绝不写盘改全局激活（不用 PUT /model）；
  // 有值但不存在/无 key 时明确报错，不静默回落——静默回落会让人「以为换了其实没换」。
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

  // 上下文用量采集（需求 20261106-005 P0）：llm_stats 到达时把真实 prompt_tokens
  // 写入内存 entry.lastContext（不落盘），供 GET /sessions/:id/context 与前端百分比环使用。
  // 需求 20261106-006：同时累计迭代 token / 接收 llm_stats_summary，run 结束后挂到本轮最终
  // assistant 消息的 usage 字段随会话落盘（WebUI 每条回答的 Token chip 数据源）。
  const statsRecorder = {
    /** 本轮权威累计（run 结束时由 llm_stats_summary 提供；中断时可能缺失） */
    summary: undefined as LLMStatsSummary | undefined,
    /** 逐迭代累加（summary 缺失时的兜底） */
    accPrompt: 0,
    accCompletion: 0,
    accCacheHit: 0,
    onLLMStats: (stats: LLMStats): void => {
      entry.lastContext = {
        contextTokens: stats.contextTokens,
        maxTokens: stats.contextMaxTokens,
        threshold: stats.contextThreshold,
        source: 'stats',
        at: Date.now(),
      };
      statsRecorder.accPrompt += stats.promptTokens;
      statsRecorder.accCompletion += stats.completionTokens;
      statsRecorder.accCacheHit += stats.cacheHitTokens ?? 0;
    },
    onLLMStatsSummary: (summary: LLMStatsSummary): void => {
      statsRecorder.summary = summary;
    },
  };

  // ===== 需求 20261107-002：子 Agent 过程事件收集 + 后台完成主动落盘 =====
  // 同步 delegate 的轨迹按 callId 收集，run 结束时挂到对应 tool 消息（D4）；
  // 后台子任务走独立回调，完成后追加一张结果卡片并推送 SSE（D8）。
  const subTraces = new Map<string, SubAgentTrace>();
  runOptions.onSubAgentEvent = (info) => {
    if (info.callId) {
      const trace = subTraces.get(info.callId) ?? createSubAgentTrace();
      applySubAgentEvent(trace, info);
      subTraces.set(info.callId, trace);
    }
    if (!stream) return;
    const seq = ctx.runs.publish(id, 'subagent_event', { info });
    if (seq > 0) void writeJournal(store, id, { lastSeq: seq });
  };
  // 后台子任务卡片：按 taskId 原地更新（运行中→完成/中断），避免与 updateSession 落盘互相踩踏
  // - 提交（onSubAgentStart）：由 Agent 层 await 落盘，保证运行中卡片先于本轮 updateSession 写入
  // - 完成（onSubAgentComplete）：本轮仍在落盘时先排队，flush 时再 upsert
  let turnActive = true;
  const pendingSubAgentCards: SubAgentCardRecord[] = [];

  const upsertSubAgentCard = async (record: SubAgentCardRecord): Promise<void> => {
    try {
      const data = await store.loadSession(id);
      const card: ChatMessage = {
        role: 'user',
        content: serializeSubAgentResult(record),
        is_show: true,
        is_compact: false,
        kind: 'subagent_result',
        sub: record.trace,
      };
      const idx = data.messages.findIndex(
        (m) =>
          m.role === 'user' &&
          isSubAgentResultContent(m.content) &&
          extractSubAgentTaskId(m.content) === record.taskId,
      );
      if (idx >= 0) data.messages[idx] = card;
      else data.messages.push(card);
      await store.rewriteMessages(id, data.messages);
      entry.history = data.messages.filter(
        (m) => m.role !== 'system' && m.is_compact !== true && !isDisplayOnlyContent(m.content),
      );
      if (stream) ctx.runs.publish(id, 'subagent_result', { info: record });
      log(`[api] 后台子任务 ${record.taskId} 卡片已落盘（${record.status}）`);
    } catch (e) {
      log(
        `[api] 后台子任务 ${record.taskId} 卡片落盘失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  // 提交即落盘「运行中」卡片（Agent 层 await 此回调，保证先于 updateSession 写入磁盘）
  runOptions.onSubAgentStart = async (info) => {
    await upsertSubAgentCard({
      taskId: info.taskId,
      task: info.task,
      status: 'running',
      iterations: 0,
      elapsedMs: 0,
    });
  };

  runOptions.onSubAgentComplete = async (info) => {
    const record: SubAgentCardRecord = {
      taskId: info.taskId,
      task: info.task,
      status: info.status,
      answer: info.answer,
      error: info.error,
      iterations: info.iterations,
      elapsedMs: info.elapsedMs,
      trace: info.trace,
    };
    if (turnActive) {
      pendingSubAgentCards.push(record);
      return;
    }
    await upsertSubAgentCard(record);
  };

  const flushPendingSubAgentCards = async (): Promise<void> => {
    turnActive = false;
    for (const record of pendingSubAgentCards.splice(0)) {
      await upsertSubAgentCard(record);
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
      statsRecorder,
    ];
  } else {
    // 非流式也要采集用量（不发布 SSE，仅记录）
    runOptions.events = [statsRecorder];
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
        // 需求 20261106-006：本轮 token 统计挂到最终 assistant 消息，随会话落盘
        attachTurnUsage(result.messages, buildTurnUsage(statsRecorder));
        attachSubAgentTraces(result.messages, subTraces);
        const stored = await store.updateSession(id, result.messages, message, {
          transcript: result.transcript,
        });
        entry.history = stored.filter(
          (m) => m.role !== 'system' && m.is_compact !== true && !isDisplayOnlyContent(m.content),
        );
      } catch (e) {
        warnings.push(`会话持久化失败（回答不受影响）: ${e instanceof Error ? e.message : String(e)}`);
        entry.history = result.messages.filter(
          (m) => m.role !== 'system' && m.is_compact !== true && !isDisplayOnlyContent(m.content),
        );
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
        // 需求 20261106-006：中断轮也尽量落累计 token（无 summary 时用逐迭代累加兜底）
        attachTurnUsage(sealed, buildTurnUsage(statsRecorder));
        attachSubAgentTraces(sealed, subTraces);
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
        entry.history = stored.filter(
          (m) => m.role !== 'system' && m.is_compact !== true && !isDisplayOnlyContent(m.content),
        );
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
      // 本轮结束后再落盘排队中的后台子任务结果（此后完成的卡片直接落盘）
      await flushPendingSubAgentCards();
      entry.inFlight = null;
    }
  })();

  await entry.inFlight;
}

/**
 * 需求 20261106-006：从本轮统计生成可落盘的 TurnUsage。
 * 优先 llm_stats_summary 权威累计；缺失（中断/厂商无 summary）时用逐迭代累加兜底；
 * 本轮一次 LLM 调用都没发生（如首问即中断）返回 undefined，不写 usage。
 */
function buildTurnUsage(recorder: {
  summary?: LLMStatsSummary;
  accPrompt: number;
  accCompletion: number;
  accCacheHit: number;
}): TurnUsage | undefined {
  if (recorder.summary) {
    return {
      promptTokens: recorder.summary.totalPrompt,
      completionTokens: recorder.summary.totalCompletion,
      totalTokens: recorder.summary.totalTokens,
      cacheHitTokens: recorder.summary.totalCacheHit,
      avgCacheHitRate: recorder.summary.avgCacheHitRate,
    };
  }
  if (recorder.accPrompt > 0 || recorder.accCompletion > 0) {
    return {
      promptTokens: recorder.accPrompt,
      completionTokens: recorder.accCompletion,
      totalTokens: recorder.accPrompt + recorder.accCompletion,
      cacheHitTokens: recorder.accCacheHit,
    };
  }
  return undefined;
}

/**
 * 需求 20261106-006：把本轮 usage 挂到最后一条「有正文」的 assistant 消息上
 * （与 WebUI 展示的回答 bundle 对应；纯 tool_calls 的中间 assistant 不挂）。
 * 原地修改，调用方随后交给 store.updateSession 落盘。
 */
function attachTurnUsage(messages: ChatMessage[], usage: TurnUsage | undefined): void {
  if (!usage) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content) {
      m.usage = usage;
      return;
    }
  }
}

/**
 * 需求 20261107-002 D4：把本轮收集到的子 Agent 轨迹挂到对应 delegate 工具消息上，
 * 随会话落盘；刷新后前端据此恢复「默认收起」的过程区。
 */
function attachSubAgentTraces(
  messages: ChatMessage[],
  traces: Map<string, SubAgentTrace>,
): void {
  if (traces.size === 0) return;
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const trace = traces.get(m.tool_call_id);
    if (trace) m.sub = trace;
  }
}

/** 后台子任务卡片字段（运行中/完成/中断共用同一序列化格式，仅展示，不进 LLM 历史） */
interface SubAgentCardRecord {
  taskId: string;
  task: string;
  status: 'running' | 'done' | 'failed' | 'aborted' | 'interrupted';
  answer?: string;
  error?: string;
  iterations?: number;
  elapsedMs?: number;
  trace?: SubAgentTrace;
}

/** 从卡片内容里提取 taskId（用于 upsert 定位） */
function extractSubAgentTaskId(content: string): string | undefined {
  const hit = content.match(/^taskId: ?(.+)$/m);
  return hit ? hit[1].trim() : undefined;
}

function serializeSubAgentResult(info: SubAgentCardRecord): string {
  const lines = [
    SUBAGENT_RESULT_OPEN,
    `taskId: ${info.taskId}`,
    `status: ${info.status}`,
    `task: ${info.task}`,
    `elapsedMs: ${info.elapsedMs ?? 0}`,
    `iterations: ${info.iterations ?? 0}`,
    `answer: ${info.answer ?? ''}`,
    `error: ${info.error ?? ''}`,
    SUBAGENT_RESULT_CLOSE,
  ];
  return lines.join('\n');
}
