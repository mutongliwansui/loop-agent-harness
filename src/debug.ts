import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';

/** 日志目录 */
const LOG_DIR = join(homedir(), '.loop-agent', 'logs');

/** 最大单个日志文件大小（10MB） */
const MAX_LOG_SIZE = 10 * 1024 * 1024;

/** 保留的历史日志文件数量 */
const MAX_LOG_FILES = 5;

/** 获取当前日志文件路径（按日期命名） */
function getLogPath(): string {
  const date = new Date().toISOString().split('T')[0];
  return join(LOG_DIR, `debug-${date}.log`);
}

/** 确保日志目录存在 */
function ensureDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/** 日志文件轮转 */
function rotateIfNeeded(): void {
  const path = getLogPath();
  if (!existsSync(path)) return;
  try {
    const stat = statSync(path);
    if (stat.size < MAX_LOG_SIZE) return;
    const rotated = `${path}.1`;
    writeFileSync(rotated, readFileSync(path));
    // 清理超出的历史文件
    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const old = `${path}.${i}`;
      if (existsSync(old) && i >= MAX_LOG_FILES) {
        try { unlinkSync(old); } catch {}
      }
    }
    writeFileSync(path, '');
  } catch {}
}

/** 写入日志（统一入口） */
function write(line: string): void {
  if (!config.debug) return;
  try {
    ensureDir();
    rotateIfNeeded();
    const path = getLogPath();
    appendFileSync(path, line + '\n', 'utf-8');
  } catch {
    // 静默失败，不影响主流程
  }
}

/** 格式化时间戳 */
function ts(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

/** 脱敏：API Key 只显示首尾各 4 位 */
export function maskKey(key: string): string {
  if (!key || key.length < 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** 截断长字符串 */
function truncate(s: string, max = 500): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + ` ... (${s.length} chars total)`;
}

/** 调试日志（文件输出，无 ANSI 颜色） */
export const debug = {
  /** 通用调试日志 */
  log(...args: unknown[]): void {
    if (!config.debug) return;
    write(`[DEBUG ${ts()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  },

  /** LLM 请求日志 */
  llmRequest(model: string, messagesCount: number, toolsCount: number, params?: Record<string, unknown>): void {
    if (!config.debug) return;
    const lines = [
      `[DEBUG ${ts()}] → LLM 请求`,
      `  模型: ${model}`,
      `  消息数: ${messagesCount}`,
    ];
    if (toolsCount > 0) lines.push(`  工具数: ${toolsCount}`);
    if (params) {
      const safe = { ...params };
      if (safe.apiKey) safe.apiKey = maskKey(String(safe.apiKey));
      lines.push(`  参数: ${truncate(JSON.stringify(safe, null, 2), 800)}`);
    }
    write(lines.join('\n') + '\n');
  },

  /** LLM 响应日志 */
  llmResponse(
    content: string | null,
    toolCalls: Array<{ name: string; arguments: string }> | undefined,
    elapsedMs: number,
    usage?: {
      prompt_tokens: number;
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
      completion_tokens: number;
      total_tokens: number;
    },
  ): void {
    if (!config.debug) return;
    const lines = [`[DEBUG ${ts()}] ← LLM 响应 (${elapsedMs}ms)`];
    if (content) lines.push(`  内容: ${truncate(content, 300)}`);
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        lines.push(`  工具: ${tc.name}(${truncate(tc.arguments, 200)})`);
      }
    }
    if (!content && (!toolCalls || toolCalls.length === 0)) {
      lines.push('  (空响应)');
    }
    if (usage) {
      const hit = usage.prompt_cache_hit_tokens ?? 0;
      const total = usage.prompt_tokens;
      const rate = total > 0 ? ((hit / total) * 100).toFixed(1) : '0.0';
      lines.push(
        `  Cache: ${hit}/${total} tokens hit (${rate}%) | prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`,
      );
    }
    write(lines.join('\n') + '\n');
  },

  /** LLM 错误日志 */
  llmError(error: unknown, elapsedMs: number): void {
    if (!config.debug) return;
    const msg = error instanceof Error ? error.message : String(error);
    write(`[DEBUG ${ts()}] ✗ LLM 错误 (${elapsedMs}ms)\n  ${msg}\n`);
  },

  /**
   * 缓存命中率汇总日志（Agent 运行结束时调用）
   * 统计整轮 ReAct 会话的累计缓存命中情况
   */
  cacheSummary(rounds: Array<{
    prompt_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens: number;
    total_tokens: number;
  }>): void {
    if (!config.debug || rounds.length === 0) return;
    const totalPrompt = rounds.reduce((s, r) => s + r.prompt_tokens, 0);
    const totalHit = rounds.reduce((s, r) => s + (r.prompt_cache_hit_tokens ?? 0), 0);
    const totalMiss = rounds.reduce((s, r) => s + (r.prompt_cache_miss_tokens ?? 0), 0);
    const totalCompletion = rounds.reduce((s, r) => s + r.completion_tokens, 0);
    const totalAll = rounds.reduce((s, r) => s + r.total_tokens, 0);
    const hitRate = totalPrompt > 0 ? ((totalHit / totalPrompt) * 100).toFixed(1) : '0.0';
    const savingsPct = totalAll > 0 ? ((totalHit / totalAll) * 100).toFixed(1) : '0.0';

    const lines = [
      `[DEBUG ${ts()}] ╔══ 缓存命中率汇总 ════`,
      `  迭代轮数: ${rounds.length}`,
      `  Prompt 命中率: ${totalHit}/${totalPrompt} tokens (${hitRate}%)`,
      `  节省比例 (hit/total): ${totalHit}/${totalAll} (${savingsPct}%)`,
      `  未命中 tokens: ${totalMiss}`,
      `  总输入 tokens: ${totalPrompt}`,
      `  总输出 tokens: ${totalCompletion}`,
      `  总 tokens: ${totalAll}`,
    ];
    write(lines.join('\n') + '\n');
  },

  /** 工具调用日志 */
  toolCall(name: string, args: Record<string, unknown>, result: string, elapsedMs: number): void {
    if (!config.debug) return;
    const lines = [
      `[DEBUG ${ts()}] ⚙ 工具调用`,
      `  名称: ${name}`,
      `  参数: ${truncate(JSON.stringify(args), 300)}`,
      `  结果: ${truncate(result, 300)} (${elapsedMs}ms)`,
    ];
    write(lines.join('\n') + '\n');
  },

  /** Agent 迭代日志 */
  iteration(round: number, thought: string | null, action: string, observation: string): void {
    if (!config.debug) return;
    const lines = [`[DEBUG ${ts()}] 迭代 #${round}`];
    if (thought) lines.push(`  Thought: ${truncate(thought, 200)}`);
    lines.push(`  Action: ${action}`);
    lines.push(`  Observation: ${truncate(observation, 200)}`);
    write(lines.join('\n') + '\n');
  },

  /** 会话状态日志 */
  session(messageCount: number, toolCount: number, sessionId: string | null): void {
    if (!config.debug) return;
    const lines = [
      `[DEBUG ${ts()}] 会话状态`,
      `  消息数: ${messageCount}`,
      `  工具数: ${toolCount}`,
      `  会话ID: ${sessionId ?? '(无)'}`,
    ];
    write(lines.join('\n') + '\n');
  },

  /** 获取当前日志文件路径 */
  getLogPath(): string {
    return getLogPath();
  },

  /** 读取当前日志文件内容 */
  readLog(maxChars = 10000): string {
    try {
      ensureDir();
      const path = getLogPath();
      if (!existsSync(path)) return '';
      const content = readFileSync(path, 'utf-8');
      if (content.length <= maxChars) return content;
      return content.slice(content.length - maxChars);
    } catch {
      return '';
    }
  },
};
