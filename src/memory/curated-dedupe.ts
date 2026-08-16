// Curated 写入去重/归并：Dreaming 晋升写入 L3 前，用 LLM 对候选事实与现有内容做语义合并
// 目标：消除 MEMORY.md / USER.md 中反复累积的语义重复条目
// 设计约束：LLM 调用失败或解析失败必须返回 null，由调用方回退到原 append，绝不因去重丢失事实
import type { ILLMClient } from './types.js';

const DEDUPE_PROMPT = `你是记忆整理助手。下面是记忆文件的现有内容，以及若干条候选事实。
对每条候选事实（按序号）判断应如何处理：
- append：该事实是全新信息，现有内容中没有条目覆盖它 → 追加
- merge：该事实与现有某一行条目表达同一件事，但提供了补充或更新 → 合并；line 为被合并条目的行号（从 1 起），newText 为合并后的完整新条目文本（不含前导 "- "）
- skip：该事实与现有内容完全重复，或被更新的信息覆盖 → 丢弃

判断规则：
- 语义等价即视为重复（措辞不同但意思相同 → skip）
- 同一事实的新旧信息冲突时，以新信息为准（merge，newText 保留新信息）
- 现有条目比候选更具体/更完整时 → skip
- 候选事实只有编号没有事实文本时 → skip

只输出 JSON，不要输出任何其他文字或解释。格式：
{"decisions":[{"index":1,"action":"append"},{"index":2,"action":"merge","line":3,"newText":"合并后的一句话条目"},{"index":3,"action":"skip"}]}`;

/** 每条候选事实的归并决策 */
export interface MergeDecision {
  /** 候选事实序号（0 起） */
  index: number;
  action: 'append' | 'merge' | 'skip';
  /** merge 时：被合并条目的行号（1 起） */
  line?: number;
  /** merge 时：合并后的完整条目文本（不含前导 "- "） */
  newText?: string;
}

export interface MergeResult {
  decisions: MergeDecision[];
  /** 原始响应，供 debug */
  raw: string;
}

/** 从 LLM 响应中稳健解析决策（容忍 ```json 代码块标记与多余文字） */
function parseDecisions(content: string): MergeResult | null {
  const cleaned = content
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || !Array.isArray(parsed.decisions)) return null;
    const decisions: MergeDecision[] = parsed.decisions
      .filter(
        (d: unknown): d is MergeDecision =>
          !!d &&
          typeof (d as MergeDecision).index === 'number' &&
          ['append', 'merge', 'skip'].includes((d as MergeDecision).action),
      )
      .map((d: MergeDecision) => ({
        index: d.index,
        action: d.action,
        line: d.line,
        newText: d.newText,
      }));
    return { decisions, raw: content };
  } catch {
    return null;
  }
}

/**
 * 一次 LLM 调用，对整批候选事实做去重/归并决策。
 * 短接条件（文件为空或候选为空）或任何失败时返回 null，调用方回退到原 append。
 */
export async function mergeWithLLM(
  llm: ILLMClient,
  fileContent: string,
  candidates: string[],
): Promise<MergeResult | null> {
  if (!fileContent.trim() || candidates.length === 0) return null;

  const prompt = `${DEDUPE_PROMPT}\n\n---当前文件内容（每行前的数字为行号）---\n${fileContent}\n---文件内容结束---\n\n---候选事实（按序号）---\n${candidates
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n')}\n---候选结束---`;

  try {
    const resp = await llm.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0 }, // 去重需要确定性输出
    );
    return parseDecisions(resp.content ?? '');
  } catch {
    return null;
  }
}

const DEDUPE_FILE_PROMPT = `你是记忆整理助手。下面是记忆文件的完整内容，请对其进行去重与精简整理：
- 删除完全重复的条目（语义等价即视为重复）
- 将多条描述同一事实的条目合并为一条（保留最完整的信息）
- 保留所有唯一信息，不得删减任何不重复的事实
- 不得新增文件中原不存在的任何信息
- 保持 Markdown 标题与结构不变（# 标题、## 小节、- 条目）
- 输出整理后的完整文件内容

只输出整理后的文件内容本身，不要输出解释，不要用代码块包裹。`;

/**
 * 对单个 Curated 文件做存量去重（/memory curated dedupe 使用）。
 * 让 LLM 输出精简后的完整文件内容；失败或内容为空时返回 null。
 */
export async function dedupeCuratedFile(
  llm: ILLMClient,
  fileContent: string,
): Promise<string | null> {
  if (!fileContent.trim()) return null;

  const prompt = `${DEDUPE_FILE_PROMPT}\n\n---文件内容---\n${fileContent}\n---文件结束---`;
  try {
    const resp = await llm.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0 }, // 精简需要确定性输出
    );
    const cleaned = (resp.content ?? '')
      .replace(/```(?:md|markdown)?\s*/gi, '')
      .replace(/```/g, '')
      .trim();
    return cleaned || null;
  } catch {
    return null;
  }
}
