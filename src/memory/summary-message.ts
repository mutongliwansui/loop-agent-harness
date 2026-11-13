import type { ChatMessage } from '../types.js';

/** 压缩摘要的目标长度上限：写入压缩指令，约束模型输出不超过该字数（需求 20261113-008 D1：500→800） */
export const SUMMARY_MAX_CHARS = 800;

/** 摘要落盘/注入时的硬截断上限：目标值上浮 20%，容忍模型小幅超写，避免正常输出被腰斩 */
export const SUMMARY_TRUNCATE_MAX_CHARS = Math.ceil(SUMMARY_MAX_CHARS * 1.2);

/**
 * 当前轮 user 原文段的字数上限（需求 20261113-008 D6）。
 * 与摘要主体分开计算：它不由 LLM 生成，也就不受 SUMMARY_MAX_CHARS 约束。
 */
export const ANCHOR_USER_MAX_CHARS = 800;

/** 原文段头部保留字数：头 500 + 尾 300，保证尾部的上传附件 note 不被切掉 */
export const ANCHOR_HEAD_CHARS = 500;

/** 原文段尾部保留字数 */
export const ANCHOR_TAIL_CHARS = 300;

/**
 * 原文段分隔标记（需求 20261113-008 D5）。
 * 前置 `\n` 降低与「摘要正文 / 用户原文」误撞的概率。
 */
export const ANCHOR_SECTION_MARK = '\n[当前问题] ';

/** 原文段截断提示模板（保留被省略字数，便于判断原文完整度） */
const ANCHOR_OMIT_TPL = (n: number): string => `…（已省略 ${n} 字）…`;

/**
 * 摘要占位的 token 预留上界（需求 20261113-008 D1）。
 *
 * 摘要占位 = 「LLM 摘要主体 + 当前轮原文段」两段文本，本身要占 token。
 * `planCompaction` 计算保留预算时按该上界扣除，否则压缩完成后总量仍可能贴着阈值，
 * 下一轮立刻又触发压缩（空转）。
 */
export const SUMMARY_PLACEHOLDER_RESERVE_TOKENS = Math.ceil(
  (SUMMARY_MAX_CHARS + ANCHOR_USER_MAX_CHARS) / 4,
);

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

/**
 * 原文段兜底截断：头尾保留，中间标注省略字数。
 *
 * 为什么不是单纯头部截断：上传附件 note 位于 user 正文**尾部**，只保头部会把它整段切掉，
 * 模型便「知道有问题、不知道有附件」，视觉工具（analyzeImage）取不到绝对路径。
 */
export function truncateAnchorText(
  text: string,
  max: number = ANCHOR_USER_MAX_CHARS,
): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length <= max) return trimmed;
  // max 可被调用方调小：按 500:300 的比例等比缩放，保证头尾都拿得到
  const headLen = Math.max(1, Math.min(ANCHOR_HEAD_CHARS, Math.floor((max * 5) / 8)));
  const tailLen = Math.max(1, Math.min(ANCHOR_TAIL_CHARS, max - headLen));
  const omitted = trimmed.length - headLen - tailLen;
  if (omitted <= 0) return trimmed;
  return `${trimmed.slice(0, headLen)}${ANCHOR_OMIT_TPL(omitted)}${trimmed.slice(-tailLen)}`;
}

/**
 * 从「摘要主体 + 可能存在的原文段」文本中切出两部分。
 *
 * 未命中标记时 `anchor` 为 undefined（兼容需求上线前落盘的存量摘要），不报错。
 */
export function splitAnchorSection(body: string): { summary: string; anchor?: string } {
  const text = typeof body === 'string' ? body : '';
  const idx = text.indexOf(ANCHOR_SECTION_MARK);
  if (idx < 0) return { summary: text.trim() };
  const summary = text.slice(0, idx).trim();
  const anchor = text.slice(idx + ANCHOR_SECTION_MARK.length).trim();
  return anchor ? { summary, anchor } : { summary };
}

/**
 * 拼装摘要占位主体（不含 `[历史摘要]` 前缀）。
 *
 * 幂等保障（需求 20261113-008 D5）：无论 `summary` 传进来的是纯摘要，还是「沿用旧占位」
 * 得到的带原文段全文，都会先剥掉其中的原文段再拼**本次**的原文段——保证占位里
 * `\n[当前问题] ` 永远只出现一次，重复压缩不叠加。
 *
 * 注意：上游 `planCompaction` 提取 `previousSummary`（喂 LLM）时**不剥**原文段，
 * 让模型仍能看到历史问题；剥离只发生在「写回占位」这一侧。
 */
export function composeSummaryBody(summary: string, anchorText?: string): string {
  const base = splitAnchorSection(summary).summary;
  const anchor = truncateAnchorText(anchorText ?? '');
  if (!anchor) return base;
  return base ? `${base}${ANCHOR_SECTION_MARK}${anchor}` : anchor;
}

/** 原文段「是否已在摘要正文里」的判据长度：取原文头部该长度做指纹 */
export const ANCHOR_DEDUPE_CHARS = 120;

/**
 * 原文段去重（需求 20261113-008）。
 *
 * 典型场景：flush 失败走 `flushFailure='archive'` 回退时，`summaryText` 由 droppable 全文拼成，
 * 当前轮 user 原文已在内，再追加原文段就会重复。此处以原文头部指纹判断，命中则丢弃原文段。
 */
export function dedupeAnchorText(
  summaryBody: string,
  anchorText?: string,
): string | undefined {
  const anchor = truncateAnchorText(anchorText ?? '');
  if (!anchor) return undefined;
  if (!summaryBody) return anchor;
  const fingerprint = anchor.slice(0, ANCHOR_DEDUPE_CHARS);
  return summaryBody.includes(fingerprint) ? undefined : anchor;
}
