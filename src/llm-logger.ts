// LLM 调用日志：独立于 debug 日志，记录每次模型调用的输入参数与响应
// 用途：排查缓存命中率（前缀缓存依赖 system prompt 稳定）、上下文组装、token 消耗等
// 输出：~/.loop-agent/logs/llm-YYYY-MM-DD.log（默认开启，受 agent.llmLogEnabled 控制）
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

/** 获取当前日志文件路径（按日期命名） */
function getLogPath(): string {
  const date = new Date().toISOString().split('T')[0];
  return join(LOG_DIR, `llm-${date}.log`);
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

/** 写入日志（独立开关：agent.llmLogEnabled） */
function write(line: string): void {
  if (!config.llmLogEnabled) return;
  try {
    ensureDir();
    rotateIfNeeded();
    appendFileSync(getLogPath(), line + '\n', 'utf-8');
  } catch {
    // 静默失败，不影响主流程
  }
}

/** 单条消息格式化：role、长度、完整内容（全量输出，不截断） */
function formatMessage(msg: ChatMessage, index: number): string {
  const content = msg.content ?? '';
  const line = `    [${index}] ${msg.role} (${content.length} 字符): ${content}`;
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    const names = msg.tool_calls.map((tc) => tc.function?.name ?? '?').join(', ');
    return line + ` | tool_calls=[${names}]`;
  }
  if (msg.role === 'tool') {
    return line + ` | tool_call_id=${msg.tool_call_id ?? '?'}`;
  }
  return line;
}

/** 调用序号（进程内自增，便于 request/response 配对） */
let seq = 0;
function nextId(): number {
  return ++seq;
}

export interface LLMCallRequest {
  id: number;
  model: string;
  temperature: number;
  toolsCount: number;
  maxTokens?: number;
  messages: ChatMessage[];
}

export interface LLMCallResponse {
  id: number;
  response: LLMResponse;
  elapsedMs: number;
}

/** LLM 调用日志 */
export const llmLogger = {
  /** 记录模型调用请求（输入参数 + 完整消息列表，全量输出） */
  request(req: LLMCallRequest): void {
    const lines = [
      `════════ LLM 调用 #${req.id} ${new Date().toISOString()} ════════`,
      `请求: model=${req.model} temperature=${req.temperature} tools=${req.toolsCount}${req.maxTokens !== undefined ? ` maxTokens=${req.maxTokens}` : ''}`,
      `输入消息 (${req.messages.length} 条):`,
    ];
    req.messages.forEach((m, i) => lines.push(formatMessage(m, i)));
    write(lines.join('\n'));
  },

  /** 记录模型调用响应（完整内容 + usage，含缓存命中率） */
  response(res: LLMCallResponse): void {
    const { response, elapsedMs } = res;
    const lines = [
      `── 响应 #${res.id} (${elapsedMs}ms) ──`,
      `  完成原因: ${response.finish_reason}`,
    ];
    if (response.content) {
      lines.push(`  内容: ${response.content}`);
    } else if (response.tool_calls && response.tool_calls.length > 0) {
      for (const tc of response.tool_calls) {
        lines.push(`  工具调用: ${tc.function?.name ?? '?'}(${tc.function?.arguments ?? ''})`);
      }
    } else {
      lines.push('  (空响应)');
    }
    if (response.usage) {
      const u = response.usage;
      const hit = u.prompt_cache_hit_tokens ?? 0;
      const miss = u.prompt_cache_miss_tokens ?? 0;
      const rate = u.prompt_tokens > 0 ? ((hit / u.prompt_tokens) * 100).toFixed(1) : '0.0';
      lines.push(
        `  Usage: prompt=${u.prompt_tokens} hit=${hit} miss=${miss} 命中率=${rate}% | completion=${u.completion_tokens} total=${u.total_tokens}`,
      );
    }
    lines.push('');
    write(lines.join('\n'));
  },
};

/** 便捷入口：发起一次调用（返回 callId 供 response 配对） */
export function beginLLMCall(): number {
  return nextId();
}
