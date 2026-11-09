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
import { subAgentRegistry } from '../../agent/subagent-registry.js';
import { peekBackgroundNotices } from '../../agent/background-notice.js';
import { buildSubAgentWakeNotice, SUBAGENT_WAKE_PREFIX } from '../subagent-notice.js';
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
 * runMessageTurn 的内部选项。
 * wake=true：由后台子任务完成通知触发的「唤醒轮次」——
 * 输入只进 LLM（不进消息时间线，结果卡片已承担展示），落盘前剔除该合成用户消息。
 */
export interface RunTurnOptions {
  wake?: boolean;
}

/**
 * 后台子任务完成通知的前缀（情况1：主 run 仍在运行时作为一轮 user 消息插入 Loop）。
 * 情况2 唤醒轮次还会用它把合成输入从落盘消息里剔除，避免会话里多出一条用户气泡。
 */
// SUBAGENT_WAKE_PREFIX 与 buildSubAgentWakeNotice 已迁移到 ../subagent-notice.ts
// （需求 20261108-001：超长结果落盘 tmp，通知带路径 + 预览，见该模块头部注释）

/**
 * 剔除唤醒轮次注入的合成用户消息（只影响落盘/回显，LLM 已在运行期看过）。
 * 只按「与唤醒输入完全一致」匹配最后一条，避免误删历史里内容相近的用户消息。
 */
function stripWakeInput(messages: ChatMessage[], input: string): ChatMessage[];
function stripWakeInput(
  messages: ChatMessage[] | undefined,
  input: string,
): ChatMessage[] | undefined;
function stripWakeInput(
  messages: ChatMessage[] | undefined,
  input: string,
): ChatMessage[] | undefined {
  if (!messages) return messages;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role === 'user' && m.content === input) {
      out.splice(i, 1);
      break;
    }
  }
  return out;
}

/**
 * 启动一轮对话并通过 SSE/JSON 返回结果（需求 20261106-005 P1：重试复用此公共段）。
 *
 * 调用方负责：会话存在性、`inFlight` 互斥、重试时的历史截断。
 */
export async function runMessageTurn(
  ctx: HandlerContext,
  /** HTTP 响应；内部唤醒（后台子任务完成触发新一轮）无调用方连接时传 null */
  res: ServerResponse | null,
  id: string,
  message: string,
  stream: boolean,
  modelAliasRaw: string,
  opts?: RunTurnOptions,
): Promise<void> {
  const { deps, log } = ctx;
  /** 内部唤醒轮次：输入为后台完成通知，只给 LLM 看，不回显到会话时间线 */
  const wake = opts?.wake === true;

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
      await store.updateSession(
        id,
        wake ? stripWakeInput(snapshot.messages, message) : snapshot.messages,
        message,
        {
          transcript: wake ? stripWakeInput(snapshot.transcript, message) : snapshot.transcript,
        },
      );
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
  /**
   * 后台子任务的描述文本（taskId → task，需求 20261107-008 P2）：
   * onSubAgentEvent 只带 callId，增量落盘时要用它拼卡片内容。
   */
  const subTaskText = new Map<string, string>();
  /**
   * 过程轨迹增量落盘节流（需求 20261107-008 P2 / task-006 B6）：
   * 后台任务运行中刷新页面时 running 卡片有、trace 却是空的。每事件落盘会造成
   * 写放大（tool_progress 高频），故按间隔节流；收敛时 onSubAgentComplete 覆盖为最终轨迹。
   */
  const SUB_TRACE_FLUSH_MS = 8000;
  const lastTraceFlush = new Map<string, number>();

  // ===== 后台子任务卡片落盘（位置约束见下） =====
  // updateSession 只「追加」本轮消息，不重排已有条目。若 delegate 提交时就把卡片 append 落盘，
  // 此刻本轮的用户消息还只在内存里（要等首个快照或收尾才写盘），卡片就会排到用户消息**之前**。
  // 故本轮进行中的卡片一律先排队，等本轮落盘结束（finally）再写：位置自然落在本轮消息之后，
  // 与「结果到达时的时间线末尾」语义一致；同一 taskId 只保留最新一份（start → done 覆盖）。
  let turnActive = true;
  const pendingSubAgentCards: SubAgentCardRecord[] = [];

  /** 本轮仍在进行：卡片排队（同 taskId 后者覆盖，避免 start/trace/done 各写一次盘） */
  const queueSubAgentCard = (record: SubAgentCardRecord): void => {
    const i = pendingSubAgentCards.findIndex((r) => r.taskId === record.taskId);
    if (i >= 0) pendingSubAgentCards[i] = record;
    else pendingSubAgentCards.push(record);
  };

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

  runOptions.onSubAgentEvent = (info) => {
    if (info.callId) {
      const trace = subTraces.get(info.callId) ?? createSubAgentTrace();
      applySubAgentEvent(trace, info);
      subTraces.set(info.callId, trace);
      // 后台子任务（callId 即 sub_ 前缀的 taskId）：节流落盘过程轨迹
      if (info.callId.startsWith('sub_')) {
        const now = Date.now();
        // P2（20261107-009）：把运行中进度同步进 registry，让 /subagents 在运行中
        // 就带回真实轮次与耗时（前端 running 卡片/指示器据此显示「已运行 Xs · N 轮」）
        subAgentRegistry.touch(info.callId, {
          iterations: trace.iterations,
          elapsedMs: trace.startedAt ? now - trace.startedAt : undefined,
        });
        if (now - (lastTraceFlush.get(info.callId) ?? 0) >= SUB_TRACE_FLUSH_MS) {
          lastTraceFlush.set(info.callId, now);
          const fork: SubAgentTrace = structuredClone(trace);
          const record: SubAgentCardRecord = {
            taskId: info.callId,
            task: subTaskText.get(info.callId) ?? '',
            status: 'running',
            iterations: fork.iterations,
            elapsedMs: fork.startedAt ? now - fork.startedAt : 0,
            trace: fork,
          };
          if (turnActive) queueSubAgentCard(record);
          else void upsertSubAgentCard(record);
        }
      }
    }
    if (!stream) return;
    const seq = ctx.runs.publish(id, 'subagent_event', { info });
    if (seq > 0) void writeJournal(store, id, { lastSeq: seq });
  };
  // 提交即登记「运行中」卡片：本轮未结束时只排队（见上方位置约束），收尾后由 finally 统一落盘
  runOptions.onSubAgentStart = (info) => {
    subTaskText.set(info.taskId, info.task); // 供过程轨迹落盘拼卡片内容（P2）
    queueSubAgentCard({
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
    const notice = await buildSubAgentWakeNotice({ ...info });
    if (turnActive) {
      queueSubAgentCard(record);
      // 情况1：主 run 仍在跑 → 完成通知入队，由下一轮 LLM 调用前 drain 注入 Loop
      subAgentRegistry.enqueueNotice(id, notice);
      return;
    }
    await upsertSubAgentCard(record);
    // 情况2：主 run 已结束 → 落盘结果卡片后触发一次新的模型调用（由完成通知唤醒）
    subAgentRegistry.enqueueNotice(id, notice);
    scheduleWakeMainAgent(ctx, id);
  };

  const flushPendingSubAgentCards = async (): Promise<void> => {
    turnActive = false;
    for (const record of pendingSubAgentCards.splice(0)) {
      await upsertSubAgentCard(record);
    }
  };

  if (stream) {
    // 内部唤醒轮次没有 HTTP 连接：不写帧，但仍把事件发布到 Hub，供已 attach 的客户端实时接收
    const clientRes = res;
    let clientGone = clientRes === null;
    let unsubscribe = (): void => {};
    if (clientRes) {
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      clientRes.on('close', () => {
        clientGone = true; // 停止写流，但 run 照常完成并持久化
        unsubscribe();
      });
      // 本连接作为 RunHub 的首个订阅者（cursor=0 → 全量回放；此刻尚无事件）
      const sub = ctx.runs.subscribe(id, 0, (ev) => {
        if (!clientGone) sseFrame(clientRes, ev.event, ev.data, ev.seq);
      });
      unsubscribe = sub?.unsubscribe ?? ((): void => {});
    }
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

  // 后台任务兜底唤醒开关（需求 20261108-002）：仅正常完成时允许收尾兜底。
  // 失败/中止路径不兜底——唤醒 run 若在 drain 通知前就失败，通知仍在队列，
  // 兜底再唤醒会形成「失败 → 唤醒 → 再失败」的循环；留给用户下次输入注入。
  let allowBackgroundWakeFallback = true;
  entry.inFlight = (async () => {
    try {
      // 05：sessionId 首参 → AgentPool 按会话租用独立实例（同空间多会话并发）
      const result = await runAgent(id, message, runOptions);
      // 唤醒轮次的合成输入只给 LLM 看：落盘前剔除，避免会话里多出一条用户气泡
      const finalMessages = wake ? stripWakeInput(result.messages, message) : result.messages;
      const finalTranscript = wake
        ? stripWakeInput(result.transcript, message)
        : result.transcript;

      // 持久化（API 层自持 SessionStore；会话已在 ensureEntry/loadSession 阶段确认存在）
      try {
        // 显式传原始输入供会话标题生成（messages 可能已被 L1 压缩重写，不可靠）；
        // transcript 为未经压缩的完整轨迹：压缩轮次据此归档「已被压缩、从未落盘」的消息。
        // 用 store 归一化后的会话消息作为 entry.history（摘要占位已转写为总结消息、压缩标记一致）。
        // 同时剔除 is_compact=true 的已折叠历史：与 ensureEntry 的 getRestoreMessages 恢复视图对齐，
        // 避免折叠历史重新进入 LLM 上下文并导致每轮重复触发压缩
        // 需求 20261106-006：本轮 token 统计挂到最终 assistant 消息，随会话落盘
        attachTurnUsage(finalMessages, buildTurnUsage(statsRecorder));
        attachSubAgentTraces(finalMessages, subTraces);
        const stored = await store.updateSession(id, finalMessages, message, {
          transcript: finalTranscript,
        });
        entry.history = stored.filter(
          (m) => m.role !== 'system' && m.is_compact !== true && !isDisplayOnlyContent(m.content),
        );
        // 排队的子任务卡片先落盘，再发终态事件——否则前端收到 done 后重建历史时看不到卡片
        await flushPendingSubAgentCards();
      } catch (e) {
        warnings.push(`会话持久化失败（回答不受影响）: ${e instanceof Error ? e.message : String(e)}`);
        entry.history = finalMessages.filter(
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
      if (res) {
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
        // 唤醒轮次被中断：同样剔除合成输入，时间线里只留卡片与部分输出
        const partialMessages = wake
          ? stripWakeInput(partial.messages, message)
          : partial.messages;
        const partialTranscript = wake
          ? stripWakeInput(partial.transcript, message)
          : partial.transcript;
        const sealed = sealPendingToolCalls(partialMessages);
        // 需求 20261106-006：中断轮也尽量落累计 token（无 summary 时用逐迭代累加兜底）
        attachTurnUsage(sealed, buildTurnUsage(statsRecorder));
        attachSubAgentTraces(sealed, subTraces);
        const abortedWarnings: string[] = [];
        let stored = sealed;
        try {
          stored = await store.updateSession(id, sealed, message, {
            transcript: partialTranscript,
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
        // 同成功路径：卡片先落盘，再发 aborted 终态
        await flushPendingSubAgentCards();
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
        if (res) {
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
        }
        log(`[api] 会话 ${id} 已被用户停止: ${partial.iterations} 轮 / ${partial.steps.length} 步（部分输出已落盘）`);
        allowBackgroundWakeFallback = false;
        return;
      }
      // run 抛错：流式先推已发生事件再合成 fatal 关流；非流式 500（失败轮不持久化，保留原历史）
      const msg = e instanceof Error ? e.message : String(e);
      log(`[api] 会话 ${id} 运行失败: ${msg}`);
      allowBackgroundWakeFallback = false;
      // 失败轮不落盘本轮消息，但已提交的后台任务卡片仍要保留（否则任务在跑却无迹可循）
      await flushPendingSubAgentCards();
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
      if (res) {
        if (stream) {
          res.end();
        } else {
          sendError(res, 'internal', msg);
        }
      }
    } finally {
      // 本轮结束后再落盘排队中的后台子任务结果（此后完成的卡片直接落盘）
      await flushPendingSubAgentCards();
      entry.inFlight = null;
    }
  })();

  await entry.inFlight;

  // 情况2 兜底：完成通知恰好在收尾瞬间到达、没赶上最后一轮 LLM 注入 → 收尾后唤醒主 Agent
  if (subAgentRegistry.peekNotices(id).length > 0) scheduleWakeMainAgent(ctx, id);
  // 后台命令任务通知的同类兜底（需求 20261108-002）：收尾瞬间入队、没赶上最后一轮注入。
  // 仅正常完成时兜底；失败/中止路径不兜底（见 allowBackgroundWakeFallback 注释）
  if (allowBackgroundWakeFallback && peekBackgroundNotices(id).length > 0) {
    scheduleBackgroundWake(ctx, id);
  }
}

/**
 * 后台命令任务（commandRun background）完成通知的空闲唤醒（需求 20261108-002）。
 *
 * 与子 Agent 唤醒（scheduleWakeMainAgent）镜像：
 * - 情况1（已有 run 在跑）：不唤醒——通知由该 run 的下一轮 LLM 前 drain 注入；
 * - 情况2（会话空闲）：以合成输入发起一轮 wake run 消费通知。
 *
 * 与子 Agent 的差异：详情由 display-only 通知卡片承担（run 首轮迭代 drain 注入 LLM +
 * 落盘展示），唤醒输入只是简短触发器，不携带日志尾部，避免 LLM 看到两份重复内容。
 */
export function scheduleBackgroundWake(
  ctx: HandlerContext,
  id: string,
  delayMs = 0,
  attempt = 0,
): void {
  setTimeout(() => {
    void (async () => {
      if (ctx.runs.isRunning(id)) return; // 情况1：活跃 run 会自行消费通知
      if (peekBackgroundNotices(id).length === 0) return; // 通知已被消费/清空
      try {
        // 唤醒轮沿用会话落盘的模型选择，避免后台任务把回答切回全局默认模型
        const store = ctx.registry
          ? (await locateSession(ctx.registry, id)).store
          : ctx.deps.sessionStore;
        let alias = '';
        try {
          alias = (await store.listSessions()).find((s) => s.id === id)?.modelAlias ?? '';
        } catch {
          // 别名读取失败不影响唤醒：按全局默认模型继续
        }
        await runMessageTurn(ctx, null, id, buildBackgroundWakeInput(id), true, alias, {
          wake: true,
        });
      } catch (e) {
        // 通知留在队列（未 drain 即未消费），交给后续 run 注入；有限重试互斥窗口
        if (attempt < 2) {
          scheduleBackgroundWake(ctx, id, 500, attempt + 1);
          return;
        }
        ctx.log(
          `[api] 后台任务唤醒失败（通知已留在队列）: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
  }, delayMs);
}

/** 唤醒输入前缀：run 首轮迭代 drain 到通知后，据此把「触发器」从落盘历史中剥离 */
export const BACKGROUND_WAKE_PREFIX = '[后台任务完成通知]';

/**
 * 唤醒触发器输入（需求 20261108-002）：只做「敲门」，不携带日志尾部——
 * 详情由 run 首轮迭代 drain 的 display-only 通知承担（注入 LLM + 落盘展示卡片），
 * 避免同一份日志尾部在本次请求里出现两遍。
 * 注意：不能用 <background_task_notification> 包裹——该格式会被
 * isDisplayOnlyContent 过滤出 LLM 视图，模型将看不到任何输入。
 */
function buildBackgroundWakeInput(sessionId: string): string {
  const texts = peekBackgroundNotices(sessionId);
  // 从通知文本提取 taskId（通知格式含 "taskId: xxx" 行），最多列 5 个
  const taskIds = texts
    .map((t) => /taskId: (\S+)/.exec(t)?.[1] ?? '')
    .filter(Boolean)
    .slice(0, 5);
  const head = taskIds.length > 0 ? `（taskId: ${taskIds.join('、')}）` : '';
  return [
    `${BACKGROUND_WAKE_PREFIX} 有 ${texts.length} 条后台命令任务完成通知待处理${head}。`,
    '请先读取本轮注入的通知内容，基于任务结果继续你的工作；',
    '若通知与当前对话无关，简要确认即可，不要展开无关动作。',
  ].join('\n');
}

/**
 * 后台子任务完成后唤醒主 Agent（需求：情况1/情况2）。
 *
 * 情况1（已有 run 在跑）：不入队唤醒——完成通知已进会话队列，由那次 run 的下一轮 LLM 前 drain 注入。
 * 情况2（主 run 已结束）：取走队列中的完成通知，作为合成用户输入发起一次新的模型调用。
 * 延后一拍执行，让当前 run 的 finally（inFlight 释放/响应结束）先完成；失败时把通知放回队列，
 * 交给后续 run 注入，并对「刚收尾仍在飞」的互斥窗口做有限重试。
 */
function scheduleWakeMainAgent(
  ctx: HandlerContext,
  id: string,
  delayMs = 0,
  attempt = 0,
): void {
  setTimeout(() => {
    void (async () => {
      if (ctx.runs.isRunning(id)) return; // 情况1：活跃 run 会自行消费通知
      const texts = subAgentRegistry.drainNotices(id);
      if (texts.length === 0) return;
      try {
        // 唤醒轮沿用会话落盘的模型选择，避免后台任务把回答切回全局默认模型
        const store = ctx.registry
          ? (await locateSession(ctx.registry, id)).store
          : ctx.deps.sessionStore;
        let alias = '';
        try {
          alias = (await store.listSessions()).find((s) => s.id === id)?.modelAlias ?? '';
        } catch {
          // 别名读取失败不影响唤醒：按全局默认模型继续
        }
        await runMessageTurn(ctx, null, id, texts.join('\n\n'), true, alias, { wake: true });
      } catch (e) {
        subAgentRegistry.requeueNotices(id, texts);
        if (attempt < 2) {
          scheduleWakeMainAgent(ctx, id, 500, attempt + 1);
          return;
        }
        ctx.log(
          `[api] 后台子任务唤醒失败（通知已留在队列）: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
  }, delayMs);
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
