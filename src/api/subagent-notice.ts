// 后台子任务完成通知构造（需求 20261108-001）：
// - 结果 ≤2000 字符：维持原行为，直接进通知文本
// - 结果 >2000 字符：完整落盘 ~/.loop-agent/tmp/<sessionId>/subagent-<taskId>-<ts>.txt
//   （复用 output-governor 的 buildTmpFilePath / pruneTmp，自动纳入 7 天 TTL 清理），
//   通知里只带路径 + 开头预览，LLM 需要时用 fileRead 分段读取——文件即真相源，
//   告别「…（结果过长已截断）」丢尾。
// - 落盘失败：降级回 2000 字符截断（不阻塞主流程，与原行为一致）

import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { buildTmpFilePath, sanitizeParamDigest } from '../tools/output-governor.js';

/** 通知注入体的结果字符上限（与原 buildSubAgentWakeNotice 行为一致） */
const NOTICE_RESULT_MAX_CHARS = 2000;

/** 落盘预览字符数：通知里保留结果开头，让 LLM 不读文件也能判断主题 */
const PREVIEW_MAX_CHARS = 400;

/** 后台子任务完成通知的前缀（messages.ts 剥离合成输入 / 会话回显依赖该文本） */
export const SUBAGENT_WAKE_PREFIX = '[后台子任务完成通知]';

/** 通知构造的输入（与 SubAgentCompleteInfo 的通知相关字段一致） */
export interface SubAgentWakeInfo {
  taskId: string;
  task: string;
  status: string;
  answer?: string;
  error?: string;
  iterations?: number;
  elapsedMs?: number;
  /** 会话 ID：落盘目录用；缺省时由 buildTmpFilePath 用 nosess_<ts> 兜底 */
  sessionId?: string;
}

/** 落盘结果（超长分支返回） */
interface PersistedResult {
  path: string;
  bytes: number;
  preview: string;
}

/**
 * 结果超长时完整落盘到 tmp 目录；失败返回 undefined（调用方降级截断）。
 * 同步 I/O：通知构造在完成回调里，量级一次性、文件即全量，无需流式。
 */
function persistFullResult(info: SubAgentWakeInfo, raw: string): PersistedResult | undefined {
  try {
    const ts = Math.floor(Date.now() / 1000);
    // taskId 形如 sub_<callId>；摘要取其去前缀的尾部，保证文件名可读可关联
    const digest = sanitizeParamDigest(info.taskId.replace(/^sub_/, '') || info.taskId);
    const path = buildTmpFilePath(info.sessionId, 'subagent', digest, ts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, raw, 'utf-8');
    const bytes = statSync(path).size;
    const preview = raw.slice(0, PREVIEW_MAX_CHARS);
    return { path, bytes, preview };
  } catch (e) {
    debug.log(`[subagent] 完整结果落盘失败: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * 后台完成通知文本（LLM 可见）：任务/状态/耗时/结果。
 * 超长结果完整落盘（文件即真相源），通知带路径 + 开头预览；落盘失败降级 2000 字符截断。
 */
export async function buildSubAgentWakeNotice(info: SubAgentWakeInfo): Promise<string> {
  const secs = ((info.elapsedMs ?? 0) / 1000).toFixed(1);
  const status =
    info.status === 'done' ? '已完成' : info.status === 'aborted' ? '已取消' : '失败';
  const raw = (info.error || info.answer || '').trim();

  let text: string;
  if (raw.length > NOTICE_RESULT_MAX_CHARS) {
    const persisted = persistFullResult(info, raw);
    if (persisted) {
      const kb = (persisted.bytes / 1024).toFixed(1);
      text = [
        `${persisted.preview}…`,
        '',
        `（结果共 ${raw.length} 字符，超出通知上限，完整内容已落盘：`,
        `路径: ${persisted.path}`,
        `文件大小: ${kb} KB（完整即全文，无截断）`,
        '建议: 用 fileRead 的 startLine/endLine 分段读取需要核对的部分）',
      ].join('\n');
    } else {
      // 落盘失败：降级为原截断行为，如实声明
      text = `${raw.slice(0, NOTICE_RESULT_MAX_CHARS)}\n…（结果过长已截断；完整内容落盘失败）`;
    }
  } else {
    text = raw;
  }

  return [
    `${SUBAGENT_WAKE_PREFIX} ${info.taskId} ${status}（${secs}s${info.iterations ? ` · ${info.iterations} 轮` : ''}）`,
    `任务：${info.task || '（未命名）'}`,
    `结果：${text || '（无输出）'}`,
    '请基于该结果继续你的工作；不要把同一任务重复提交为后台子任务。',
  ].join('\n');
}

// dirname 从 node:path 引入（persistFullResult 建目录用）
import { dirname } from 'node:path';
import { debug } from '../debug.js';
