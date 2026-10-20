import type { ChatMessage } from '../types.js';

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
