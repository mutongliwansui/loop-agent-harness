// DreamingPipeline：后台晋升流水线
// 巡检最近 N 天的 L2 Daily Notes → LLM 提取候选事实 → 逐条过 PromotionGate → 晋升写入 L3
// Task-16：支持按天分批提取 + 增量处理（.dreaming-state.json 记录已处理到哪一天），降低单次输入、提升前缀缓存命中率
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EpisodicMemory } from './episodic.js';
import type { PromotionGate } from './gate.js';
import type { CuratedMemory } from './curated.js';
import type { Provenance, DreamingResult } from './types.js';
import type { ILLMClient } from './types.js';
import { mergeWithLLM } from './curated-dedupe.js';
import type { CuratedFileKey } from './types.js';

const DREAMING_PROMPT = `你是记忆管理员。下面是一段近期对话记录，请提取其中值得长期记住的事实。

筛选标准：
1. 用户明确表达的偏好或约束（高优先级）
2. 被多次验证的事实（高优先级）
3. 对未来决策有指导意义的信息（中优先级）
4. 一次性临时信息（丢弃）

对每条候选事实，输出 JSON：
[{"fact": "事实陈述（一句话）", "confidence": 1-10, "category": "preference|fact|rule|skill", "targetFile": "USER.md|MEMORY.md"}]`;

interface DreamingCandidate {
  fact: string;
  confidence: number;
  category: 'preference' | 'fact' | 'rule' | 'skill';
  targetFile: 'USER.md' | 'MEMORY.md';
}

/** Dreaming 阶段进度回调（message 为给用户看的进度文案） */
export type DreamingProgress = (message: string) => void;

/** Task-16：运行选项 */
export interface DreamingRunOptions {
  /** 写入 L3 前是否做 LLM 去重/归并 */
  dedupeEnabled?: boolean;
  /** 按天分批提取（默认 true） */
  batchByDay?: boolean;
  /** 增量处理，跳过已处理的天（默认 true） */
  incremental?: boolean;
}

/** 增量状态：已处理到哪一天（ISO 日期，含当天） */
interface DreamingState {
  lastProcessedDay: string;
}

export class DreamingPipeline {
  private episodic: EpisodicMemory;
  private gate: PromotionGate;
  private curated: CuratedMemory;
  private llm: ILLMClient;

  constructor(
    episodic: EpisodicMemory,
    gate: PromotionGate,
    curated: CuratedMemory,
    llm: ILLMClient,
  ) {
    this.episodic = episodic;
    this.gate = gate;
    this.curated = curated;
    this.llm = llm;
  }

  /** 巡检最近 N 天的 daily notes */
  async run(
    daysBack = 3,
    onProgress?: DreamingProgress,
    options: DreamingRunOptions = {},
  ): Promise<DreamingResult> {
    const result: DreamingResult = { promoted: [], skipped: [], errors: [] };
    const batchByDay = options.batchByDay ?? true;
    const incremental = options.incremental ?? true;

    try {
      onProgress?.(`正在读取最近 ${daysBack} 天的记忆记录…`);
      const days = await this.episodic.readRecentDays(daysBack);
      if (days.length === 0) {
        onProgress?.('近期的记忆中暂无可整理的内容');
        return result;
      }
      onProgress?.(`已读取 ${days.length} 天的记录`);

      // 增量过滤：只处理上次之后新增的天
      let targets = days;
      if (incremental) {
        const state = await this.loadState();
        if (state.lastProcessedDay) {
          targets = days.filter((d) => d.day > state.lastProcessedDay);
        }
        if (targets.length === 0) {
          onProgress?.('最近记录已整理过，无新增内容');
          return result;
        }
        onProgress?.(`增量处理：本次 ${targets.length} 天（已跳过 ${days.length - targets.length} 天旧记录）`);
      }

      // 提取候选事实（按天分批或一次性合并）
      const candidates = await this.extractCandidates(targets, batchByDay, onProgress, result);

      if (candidates.length > 0) {
        onProgress?.(`提取到共 ${candidates.length} 条候选事实，开始逐条评估`);

        // 逐条过 Gate（仅收集晋升候选，统一去重后写入）
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          if (!cand.fact || !cand.fact.trim()) continue;
          onProgress?.(`评估晋升 ${i + 1}/${candidates.length}`);
          const provenance = this.inferProvenance(cand);
          this.gate.categorize(cand.fact, cand.category, cand.targetFile);

          if (this.gate.evaluate(cand.fact, provenance)) {
            result.promoted.push({ ...cand, provenance });
          } else {
            result.skipped.push({ ...cand, provenance });
          }
        }

        // 写入 L3：按目标文件分组，LLM 去重/归并后落盘（失败回退逐条 append）
        if (result.promoted.length > 0) {
          await this.flushPromoted(result.promoted, options.dedupeEnabled ?? true, onProgress);
        }
      } else {
        onProgress?.('未提取到候选事实');
      }

      // 全部天提取成功才推进增量状态（任一天失败则保留旧状态，下次重跑重试，避免丢数据）
      if (incremental && targets.length > 0 && result.errors.length === 0) {
        await this.saveState({ lastProcessedDay: targets[0].day });
      }

      // 保存 Gate 状态（重启不丢 pending 计数）
      await this.gate.saveState(this.curated.getWorkspaceDir());
      onProgress?.(`整理完成：晋升 ${result.promoted.length} 条，待确认 ${result.skipped.length} 条`);

    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }

    return result;
  }

  /**
   * 提取候选事实
   * - batchByDay=true：逐天调用 LLM（单次输入小、同日重跑前缀可命中）
   * - batchByDay=false：合并全部天一次调用（兼容旧行为）
   */
  private async extractCandidates(
    days: { day: string; content: string }[],
    batchByDay: boolean,
    onProgress: DreamingProgress | undefined,
    result: DreamingResult,
  ): Promise<DreamingCandidate[]> {
    if (!batchByDay) {
      onProgress?.('正在分析记录，提取候选事实…');
      const combinedContent = days.map((d) => `## ${d.day}\n${d.content}`).join('\n\n');
      try {
        const response = await this.llm.chat([
          { role: 'user', content: `${DREAMING_PROMPT}\n\n---对话记录---\n${combinedContent}` },
        ]);
        return this.parseCandidates(response.content ?? '[]');
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : String(e));
        return [];
      }
    }

    const all: DreamingCandidate[] = [];
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      onProgress?.(`按天分批提取事实（${i + 1}/${days.length}: ${d.day}）…`);
      try {
        const response = await this.llm.chat([
          {
            role: 'user',
            content: `${DREAMING_PROMPT}\n\n---对话记录（${d.day}）---\n${d.content}`,
          },
        ]);
        const parsed = this.parseCandidates(response.content ?? '[]');
        all.push(...parsed);
      } catch (e) {
        // 单天失败不阻塞其他天，记入 errors（状态不推进，下次重试）
        result.errors.push(`[${d.day}] ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return all;
  }

  /** 读取增量状态 */
  private async loadState(): Promise<DreamingState> {
    const path = this.statePath();
    if (!existsSync(path)) return { lastProcessedDay: '' };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      return { lastProcessedDay: typeof parsed?.lastProcessedDay === 'string' ? parsed.lastProcessedDay : '' };
    } catch {
      return { lastProcessedDay: '' };
    }
  }

  /** 保存增量状态（记忆目录下，天然被 git 忽略） */
  private async saveState(state: DreamingState): Promise<void> {
    try {
      writeFileSync(this.statePath(), JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // 状态写入失败不影响主流程
    }
  }

  /** 状态文件路径：{L2 记忆目录}/.dreaming-state.json */
  private statePath(): string {
    return join(this.episodic.getMemoryDir(), '.dreaming-state.json');
  }

  /** 推断候选事实的来源可信度 */
  private inferProvenance(cand: { fact: string; confidence: number }): Provenance {
    // 简单规则：confidence >= 8 → owner_direct, 6-7 → owner_derived, ...
    if (cand.confidence >= 8) return 'owner_direct';
    if (cand.confidence >= 6) return 'owner_derived';
    if (cand.confidence >= 4) return 'tool_output';
    return 'agent_inferred';
  }

  /**
   * 将晋升候选写入 L3（按目标文件分组）
   * - dedupe 开启：一次 LLM 归并调用 → applyDecisions 落盘
   * - 归并失败或解析失败：回退逐条 append，绝不丢事实
   */
  private async flushPromoted(
    promoted: { fact: string; targetFile: string }[],
    dedupeEnabled: boolean,
    onProgress?: DreamingProgress,
  ): Promise<void> {
    // 按目标文件分组（SOUL.md 不写入事实，仅 USER.md / MEMORY.md）
    const byFile = new Map<string, string[]>();
    for (const p of promoted) {
      if (p.targetFile !== 'USER.md' && p.targetFile !== 'MEMORY.md') continue;
      const list = byFile.get(p.targetFile) ?? [];
      list.push(p.fact);
      byFile.set(p.targetFile, list);
    }

    for (const [file, facts] of byFile) {
      const key: CuratedFileKey = file === 'USER.md' ? 'user' : 'memory';
      onProgress?.(`正在去重整理写入 ${file}（${facts.length} 条）…`);

      if (dedupeEnabled) {
        try {
          const content = await this.curated.read(key);
          const merged = await mergeWithLLM(this.llm, content, facts);
          if (merged && merged.decisions.length > 0) {
            const stats = await this.curated.applyDecisions(key, merged.decisions, facts);
            onProgress?.(
              `${file} 归并完成：新增 ${stats.appended}，合并 ${stats.merged}，跳过重复 ${stats.skipped}`,
            );
            continue;
          }
        } catch {
          // 归并失败回退到逐条 append
        }
      }

      for (const f of facts) {
        await this.curated.append(key, f);
      }
    }
  }

  /** 解析 LLM 返回的 JSON */
  private parseCandidates(content: string): DreamingCandidate[] {
    // 清理可能的 markdown 代码块围栏
    const cleaned = content
      .replace(/```(?:json)?/g, '')
      .replace(/^\s*```\s*$/gm, '')
      .trim();
    try {
      // 尝试直接解析
      return JSON.parse(cleaned);
    } catch {
      // 尝试提取 JSON 块
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* 解析失败返回空 */ }
      }
      return [];
    }
  }
}
