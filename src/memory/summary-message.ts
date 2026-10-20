import type { ChatMessage } from '../types.js';

/** 压缩摘要的目标长度上限：写入压缩指令，约束模型输出不超过该字数 */
export const SUMMARY_MAX_CHARS = 500;

/** 摘要落盘/注入时的硬截断上限：目标值上浮 20%，容忍模型小幅超写，避免正常输出被腰斩 */
export const SUMMARY_TRUNCATE_MAX_CHARS = Math.ceil(SUMMARY_MAX_CHARS * 1.2);

/**
 * 判断一条消息是否为「压缩总结消息」——消息种类的唯一判据（store / working 共用）。
 *
 * 新数据优先看显式标记 `kind='summary'`（toStoredMessage 落盘时写入）；
 * 旧数据没有该字段时回退到「role=user 且 is_show=false」的启发式。
 * `is_show` 只是展示标记，不能作为新数据的种类判据（否则任何隐藏消息都会被误认成摘要）。
 */
export function isSummaryMessage(m: ChatMessage): boolean {
  if (m.kind === 'summary') return true;
  if (m.kind !== undefined) return false;
  return m.role === 'user' && m.is_show === false;
}
