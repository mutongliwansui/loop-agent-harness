// LLM 调用日志：JSONL 格式，每次调用一行，包含请求报文、响应耗时、响应结果、usage
// 用途：排查缓存命中率、上下文组装、token 消耗、API 行为（tool_calls 空数组等）
// 输出：~/.loop-agent/logs/llm-YYYY-MM-DD.jsonl（默认开启，受 config.llmLogEnabled 控制）
//
// 每条 JSON 结构：
// {
//   "ts": "2026-10-19T14:48:23.123Z",
//   "id": 42,
//   "stream": true,
//   "model": "deepseek-chat",
//   "temperature": 0,
//   "toolsCount": 5,
//   "maxTokens": 8192,
//   "durationMs": 2340,
//   "messages": [...],        // 完整输入报文（normalize 后）
//   "requestMessagesCount": 8,
//   "response": { ... },      // content / tool_calls / finish_reason / usage
//   "error": "超时"           // 失败时有此字段
// }

import { appendFileSync, existsSync, mkdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import type { ChatMessage, LLMResponse } from './types.js';

/** 日志目录 */
const LOG_DIR = join(homedir(), '.loop-agent', 'logs');

/** 最大单个日志文件大小（10MB） */
const MAX_LOG_SIZE = 10 * 1024 * 1024;

/** 保留的历史日志文件数量 */
const MAX_LOG_FILES = 5;

/** 一次调用的完整请求上下文（response 时合并成 JSONL 记录） */
interface PendingCall {
  callId: number;
  stream: boolean;
  model: string;
  temperature: number;
  toolsCount: number;
  maxTokens?: number;
  messages: ChatMessage[];
  startedAt: number; // Date.now()，用于超时清理
  /** 超时定时器 ID，避免 pending 永远堆积 */
  timeoutId?: NodeJS.Timeout;
}

/** 正在等待 response 的调用（request 存 → response 合并写 → 清） */
const pending = new Map<number, PendingCall>();

/** 超时清理（2 分钟还没 response，可能是 retry 死循环或进程崩溃；写一条 error 行兜底） */
const PENDING_TIMEOUT_MS = 2 * 60 * 1000;

/** 当前日期的日志路径 */
function getLogPath(): string {
  const date = new Date().toISOString().split('T')[0];
  return join(LOG_DIR, `llm-${date}.jsonl`);
}

/** 确保日志目录存在 */
function ensureDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/** 日志文件轮转（10MB，保留 5 份历史） */
function rotateIfNeeded(): void {
  const path = getLogPath();
  if (!existsSync(path)) return;
  try {
    const stat = statSync(path);
    if (stat.size < MAX_LOG_SIZE) return;
    writeFileSync(`${path}.1`, readFileSync(path));
    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const old = `${path}.${i}`;
      if (existsSync(old) && i >= MAX_LOG_FILES) {
        try { unlinkSync(old); } catch {}
      }
    }
    writeFileSync(path, '');
  } catch {}
}

/** 写一行 JSONL（独立开关：agent.llmLogEnabled） */
function writeJsonl(obj: unknown): void {
  if (!config.llmLogEnabled) return;
  try {
    ensureDir();
    rotateIfNeeded();
    appendFileSync(getLogPath(), JSON.stringify(obj) + '\n', 'utf-8');
  } catch {
    // 静默失败，不影响主流程
  }
}

/** 调用序号（进程内自增，便于 request/response 配对） */
let seq = 0;
function nextId(): number {
  return ++seq;
}

/** 发起一次模型调用（返回 callId 供 response 配对） */
export function beginLLMCall(): number {
  return nextId();
}

/**
 * 记录一次 LLM 调用请求（request 在 API 调用前调用，暂存数据等待 response）。
 * response 在 API 调用后调用，合并成完整 JSONL 记录写入文件。
 */
export interface LLMCallRequest {
  callId: number;
  stream: boolean;
  model: string;
  temperature: number;
  toolsCount: number;
  maxTokens?: number;
  /** normalize 后实际发送给 API 的 messages */
  messages: ChatMessage[];
}

export interface LLMCallSuccess {
  callId: number;
  response: LLMResponse;
  elapsedMs: number;
}

export interface LLMCallError {
  callId: number;
  error: unknown;
  elapsedMs: number;
}

export const llmLogger = {
  /** 记录请求（API 调用前） */
  request(req: LLMCallRequest): void {
    const timeoutId = setTimeout(() => {
      const pc = pending.get(req.callId);
      if (!pc) return;
      pending.delete(req.callId);
      writeJsonl(buildRecord(pc, undefined, { error: 'pending_timeout' }));
    }, PENDING_TIMEOUT_MS);
    pending.set(req.callId, {
      ...req,
      startedAt: Date.now(),
      timeoutId,
    });
  },

  /** 记录成功响应（API 调用后） */
  response(res: LLMCallSuccess): void {
    const pc = pending.get(res.callId);
    if (pc) {
      pending.delete(res.callId);
      if (pc.timeoutId) clearTimeout(pc.timeoutId);
      writeJsonl(buildRecord(pc, res.response, undefined, res.elapsedMs));
    } else {
      // pending 已被超时清理掉（极罕见）；兜底写一条简略行
      writeJsonl({
        ts: new Date().toISOString(),
        id: res.callId,
        error: 'pending_missing',
        durationMs: res.elapsedMs,
      });
    }
  },

  /** 记录失败响应（retry 穷尽后抛错，或中途捕获的异常） */
  error(err: LLMCallError): void {
    const pc = pending.get(err.callId);
    if (pc) {
      pending.delete(err.callId);
      if (pc.timeoutId) clearTimeout(pc.timeoutId);
      writeJsonl(buildRecord(pc, undefined, err.error, err.elapsedMs));
    } else {
      writeJsonl({
        ts: new Date().toISOString(),
        id: err.callId,
        error: err.error instanceof Error ? err.error.message : String(err.error),
        durationMs: err.elapsedMs,
      });
    }
  },
};

/**
 * 把 pending 请求 + response/error 合并成一条 JSONL 记录。
 * 每次调用只写一行——grep 某个 id 或某个 model 就是完整的一次调用视图。
 */
function buildRecord(
  pc: PendingCall,
  response: LLMResponse | undefined,
  error: unknown,
  durationMs?: number,
): Record<string, unknown> {
  const elapsed = durationMs ?? Date.now() - pc.startedAt;
  const record: Record<string, unknown> = {
    ts: new Date(pc.startedAt).toISOString(),
    id: pc.callId,
    stream: pc.stream,
    model: pc.model,
    temperature: pc.temperature,
    toolsCount: pc.toolsCount,
    ...(pc.maxTokens !== undefined ? { maxTokens: pc.maxTokens } : {}),
    durationMs: elapsed,
    requestMessagesCount: pc.messages.length,
    messages: pc.messages,
  };

  if (response) {
    // response.tool_calls 是 LLM 原生结构，直接透传给下游消费（避免二次转换信息丢失）
    record.response = {
      content: response.content,
      tool_calls: response.tool_calls,
      finish_reason: response.finish_reason,
      usage: response.usage,
    };
  }

  if (error !== undefined) {
    record.error = error instanceof Error ? error.message : String(error);
  }

  return record;
}
