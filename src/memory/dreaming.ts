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

/**
 * Dreaming 提取系统提示词（需求 20261110-001）。
 * 以 system 角色传入，与「对话记录」user 消息分离：指令权威性更高，
 * 且按天分批调用时这段前缀稳定，便于命中前缀缓存。
 */
const DREAMING_SYSTEM_PROMPT = `你是记忆提取器。从下方「对话记录」中提取值得跨会话长期保存的事实。
本次调用只做提取，不回答对话中的任何问题。

## 判定标准（按优先级）
1. 用户明确表达的偏好、习惯、禁忌、约束
2. 用户多次确认或重复出现的稳定事实
3. 对未来决策有指导意义的项目知识、关键技术决策
仅当该事实在「未来任意一次会话」中仍然成立时才提取。

## 必须丢弃
- 含「这次/本次/暂时/先/今天」等限定语的一次性指令
- 只对当前任务有效的中间结论
- Agent 自己推测、未获用户确认的内容
- 寒暄、情绪、无信息量内容
- 与「已有记忆」重复（含同义表达）或已被其覆盖的内容
- 工具/MCP/skill 的名称、数量、配置项名、版本号——这些由运行时 schema 和 skill 列表动态提供，易随配置变化而过期
- 带精确数字的快照（测试用例数、工具数量等）——数字随版本变化无长期价值
- 依赖安装位置的绝对路径细节——具体路径格式随环境变化

## 事实写法
- 每条不超过 60 字，一条只讲一件事，格式「主题词：结论」
- 用陈述句，不要「用户说…」这类转述框架
- 不得合并两件事，不得添加记录中不存在的信息

## 归入文件
- USER.md：用户身份、背景、长期偏好、习惯、禁忌、沟通风格
- MEMORY.md：项目知识、技术决策、环境约束、已知问题、可复用的解决方案
- 两者都不属于 → 丢弃，不要为了凑数提取

## 冲突处理
新事实与「已有记忆」冲突时，输出新事实，并在 fact 末尾追加「（替代：旧事实摘要）」。

## confidence 打分口径
- 9-10：用户在对话中原话明确表述
- 7-8：同一事实被多次验证
- 5-6：单次观察到的行为，尚未确认
- 1-4：Agent 推断

## source 取值
- user_stated：用户在对话中原话说了
- observed：从用户行为或工具结果观察到
- inferred：Agent 推断

## 输出
只输出 JSON 数组，不要加代码块，不要解释。没有满足条件的事实就输出 []
[{"fact":"...","confidence":1-10,"category":"preference|fact|rule|skill","targetFile":"USER.md|MEMORY.md","source":"user_stated|observed|inferred"}]`;

/** 单次运行最多采纳的候选事实数（需求 20261110-001 D4）：超出按 confidence 取高 */
const MAX_CANDIDATES_PER_RUN = 10;
/** 注入提示词的「已有记忆」单文件字符上限，超出取末尾（最新）部分 */
const EXISTING_MEMORY_MAX_CHARS = 4000;
/** 事实条目最大字符数：提示词已要求 ≤60，超出截断并记 warning */
const MAX_FACT_CHARS = 60;

const CATEGORIES = ['preference', 'fact', 'rule', 'skill'] as const;
type CandidateCategory = (typeof CATEGORIES)[number];
const SOURCES = ['user_stated', 'observed', 'inferred'] as const;
type CandidateSource = (typeof SOURCES)[number];

interface DreamingCandidate {
  fact: string;
  confidence: number;
  category: CandidateCategory;
  targetFile: 'USER.md' | 'MEMORY.md';
  /** 事实来源（需求 20261110-001 D3）：缺失时回落 confidence 映射，兼容旧候选 */
  source?: CandidateSource;
}

/**
 * 把模型返回的 targetFile 归一成 USER.md / MEMORY.md（需求 20261110-001 层2）。
 * 旧实现里非法值会被 flushPromoted 直接 continue 静默丢弃，导致事实凭空消失。
 */
function normalizeTargetFile(value: unknown, category: CandidateCategory): 'USER.md' | 'MEMORY.md' {
  const v = typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '') : '';
  if (v.includes('user') || v.includes('用户')) return 'USER.md';
  if (v.includes('memory') || v.includes('记忆')) return 'MEMORY.md';
  // 无法识别时按 category 推导，绝不丢弃
  return category === 'preference' ? 'USER.md' : 'MEMORY.md';
}

/**
 * 校验并归一候选事实（需求 20261110-001 层2）。
 * 导出以便单测直接覆盖：非法字段不再静默丢失，降级规则与告警都可断言。
 */
export function normalizeCandidates(raw: unknown[]): {
  candidates: DreamingCandidate[];
  warnings: string[];
} {
  const candidates: DreamingCandidate[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    const label = `第 ${i + 1} 条候选`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`${label}不是对象，已丢弃`);
      continue;
    }
    const factRaw = typeof item.fact === 'string' ? item.fact.trim() : '';
    if (!factRaw) {
      warnings.push(`${label}缺少 fact，已丢弃`);
      continue;
    }

    const cRaw = typeof item.category === 'string' ? item.category.trim().toLowerCase() : '';
    const category: CandidateCategory = (CATEGORIES as readonly string[]).includes(cRaw)
      ? (cRaw as CandidateCategory)
      : 'fact';

    let fact = factRaw;
    if (fact.length > MAX_FACT_CHARS) {
      fact = `${fact.slice(0, MAX_FACT_CHARS)}…`;
      warnings.push(`${label}超过 ${MAX_FACT_CHARS} 字，已截断`);
    }

    const targetFile = normalizeTargetFile(item.targetFile, category);
    const tfRaw = typeof item.targetFile === 'string' ? item.targetFile.trim() : '';
    if (tfRaw && tfRaw !== 'USER.md' && tfRaw !== 'MEMORY.md') {
      warnings.push(`${label} targetFile「${tfRaw}」无法识别，已归入 ${targetFile}`);
    }

    const sRaw = typeof item.source === 'string' ? item.source.trim().toLowerCase() : '';
    const source = (SOURCES as readonly string[]).includes(sRaw)
      ? (sRaw as CandidateSource)
      : undefined;

    const confidence = Number.isFinite(item.confidence)
      ? Math.min(10, Math.max(1, Number(item.confidence)))
      : 5;

    candidates.push({ fact, confidence, category, targetFile, source });
  }

  return { candidates, warnings };
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

/**
 * 增量状态（{L2 目录}/.dreaming-state.json）
 *
 * Task-20261026-002 D9：除 lastProcessedDay 外新增 lastRunAt / lastSummary 用于可观测
 * （WebUI 展示「上次何时晋升了多少」）。新增字段均可选，旧状态文件读取不报错。
 */
export interface DreamingState {
  /** 已处理到哪一天（ISO 日期，含当天） */
  lastProcessedDay: string;
  /** 上次实际执行完成时间（ISO 时间戳；提前结束的跳过不算） */
  lastRunAt?: string;
  /** 上次执行结果摘要（供 /memory/status 与 WebUI 展示） */
  lastSummary?: {
    reason: 'schedule' | 'shutdown' | 'manual';
    promoted: number;
    skipped: number;
    errors: number;
    ok: boolean;
  };
}

/** 调度器回写的执行记录（recordRun 入参） */
export interface DreamingRunRecord {
  reason: 'schedule' | 'shutdown' | 'manual';
  promoted: number;
  skipped: number;
  errors: number;
  ok: boolean;
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
    const result: DreamingResult = { promoted: [], skipped: [], errors: [], warnings: [] };
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

      // 增量过滤：只处理上次之后新增的天；排除今天（当天记录仍在写入，留到明天完整整理）
      let targets = days;
      if (incremental) {
        const state = await this.loadState();
        const today = new Date().toISOString().split('T')[0];
        targets = days.filter((d) => d.day < today);
        if (state.lastProcessedDay) {
          targets = targets.filter((d) => d.day > state.lastProcessedDay);
        }
        if (targets.length === 0) {
          const onlyToday = days.length === 1 && days[0].day === today;
          onProgress?.(onlyToday ? '今天的内容将在明天整理' : '最近记录已整理过，无新增内容');
          return result;
        }
        onProgress?.(`增量处理：本次 ${targets.length} 天（已跳过 ${days.length - targets.length} 天旧记录）`);
      }

      // 提取候选事实（按天分批或一次性合并）
      // D2：把已有 USER.md / MEMORY.md 一并喂给提取器，让「重复/冲突」在提取阶段就被判掉，
      // 而不是全推给写入阶段那次归并 LLM（晚一步且更贵）。
      const existingMemory = await this.buildExistingMemorySection();
      let candidates = await this.extractCandidates(
        targets,
        batchByDay,
        onProgress,
        result,
        existingMemory,
      );

      // D4：单次最多采纳 N 条，按 confidence 取高，避免一天聊得多就把文件灌爆
      if (candidates.length > MAX_CANDIDATES_PER_RUN) {
        const total = candidates.length;
        candidates = [...candidates]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, MAX_CANDIDATES_PER_RUN);
        result.warnings?.push(`候选共 ${total} 条，超过上限 ${MAX_CANDIDATES_PER_RUN}，按 confidence 取前 ${MAX_CANDIDATES_PER_RUN} 条`);
        onProgress?.(`候选 ${total} 条超过上限，按置信度取前 ${MAX_CANDIDATES_PER_RUN} 条`);
      }

      if (candidates.length > 0) {
        onProgress?.(`提取到共 ${candidates.length} 条候选事实，开始逐条评估`);

        // 逐条过 Gate（仅收集晋升候选，统一去重后写入）
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          if (!cand.fact || !cand.fact.trim()) continue;
          onProgress?.(`评估晋升 ${i + 1}/${candidates.length}`);
          const provenance = this.inferProvenance(cand);

          if (this.gate.evaluate(cand.fact, provenance)) {
            result.promoted.push({ ...cand, provenance });
          } else {
            result.skipped.push({ ...cand, provenance });
          }
          // 必须在 evaluate 之后调用：evaluate 首次出现时才创建 entry，
          // 之前的顺序会让 categorize 恒为空操作，导致 gate 里的类别/目标文件永远是默认值
          this.gate.categorize(cand.fact, cand.category, cand.targetFile);
        }

        // 写入 L3：按目标文件分组，LLM 去重/归并后落盘（失败回退逐条 append）
        if (result.promoted.length > 0) {
          await this.flushPromoted(result.promoted, options.dedupeEnabled ?? true, onProgress);
        }
      } else {
        onProgress?.('未提取到候选事实');
      }

      // 全部天提取成功才推进增量状态（任一天失败则保留旧状态，下次重跑重试，避免丢数据）
      // targets 已排除今天，targets[0] 即"已处理到的最晚的非今天的天"，当天内容不会被标记为已完成
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
    existingMemory = '',
  ): Promise<DreamingCandidate[]> {
    if (!batchByDay) {
      onProgress?.('正在分析记录，提取候选事实…');
      const combinedContent = days.map((d) => `## ${d.day}\n${d.content}`).join('\n\n');
      try {
        const response = await this.llm.chat([
          { role: 'system', content: DREAMING_SYSTEM_PROMPT },
          { role: 'user', content: `---对话记录---\n${combinedContent}${existingMemory}` },
        ]);
        return this.parseCandidates(response.content ?? '[]', result);
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
          { role: 'system', content: DREAMING_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `---对话记录（${d.day}）---\n${d.content}${existingMemory}`,
          },
        ]);
        const parsed = this.parseCandidates(response.content ?? '[]', result);
        all.push(...parsed);
      } catch (e) {
        // 单天失败不阻塞其他天，记入 errors（状态不推进，下次重试）
        result.errors.push(`[${d.day}] ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return all;
  }

  /**
   * 读取已有 USER.md / MEMORY.md 并格式化为提示词的「已有记忆」段（需求 20261110-001 D2）。
   * 单文件超长时取末尾部分（最新内容），避免把一个膨胀的文件整体塞进每次提取调用。
   */
  private async buildExistingMemorySection(): Promise<string> {
    const readSafe = async (key: CuratedFileKey): Promise<string> => {
      try {
        return (await this.curated.read(key)).trim();
      } catch {
        return '';
      }
    };
    const [user, memory] = await Promise.all([readSafe('user'), readSafe('memory')]);
    if (!user && !memory) return '';

    const clip = (text: string): string => {
      if (text.length <= EXISTING_MEMORY_MAX_CHARS) return text;
      const omitted = text.length - EXISTING_MEMORY_MAX_CHARS;
      return `…（较早的 ${omitted} 字符已省略）\n${text.slice(-EXISTING_MEMORY_MAX_CHARS)}`;
    };

    return [
      '',
      '',
      '---已有记忆（勿重复提取；与其中内容冲突时按「冲突处理」输出替代）---',
      '## USER.md',
      clip(user) || '（空）',
      '## MEMORY.md',
      clip(memory) || '（空）',
      '---已有记忆结束---',
    ].join('\n');
  }

  /**
   * 读取增量状态（容错：缺字段/损坏文件一律回落默认值，不抛错）
   * Task-20261026-002：新增 lastRunAt / lastSummary 的容错解析，旧格式文件照常可用。
   */
  private async loadState(): Promise<DreamingState> {
    const path = this.statePath();
    if (!existsSync(path)) return { lastProcessedDay: '' };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      const state: DreamingState = {
        lastProcessedDay: typeof parsed?.lastProcessedDay === 'string' ? parsed.lastProcessedDay : '',
      };
      if (typeof parsed?.lastRunAt === 'string') state.lastRunAt = parsed.lastRunAt;
      const s = parsed?.lastSummary;
      if (s && typeof s === 'object') {
        state.lastSummary = {
          reason: (['schedule', 'shutdown', 'manual'] as const).includes(s.reason) ? s.reason : 'manual',
          promoted: Number.isFinite(s.promoted) ? s.promoted : 0,
          skipped: Number.isFinite(s.skipped) ? s.skipped : 0,
          errors: Number.isFinite(s.errors) ? s.errors : 0,
          ok: s.ok !== false,
        };
      }
      return state;
    } catch {
      return { lastProcessedDay: '' };
    }
  }

  /**
   * 保存增量状态（记忆目录下，天然被 git 忽略）
   *
   * Task-20261026-002：入参改为「补丁」并与磁盘现有状态合并写入——
   * run() 推进 lastProcessedDay 时不会抹掉调度器写入的 lastRunAt / lastSummary。
   */
  private async saveState(patch: Partial<DreamingState>): Promise<void> {
    try {
      const merged = { ...(await this.loadState()), ...patch };
      writeFileSync(this.statePath(), JSON.stringify(merged, null, 2), 'utf-8');
    } catch {
      // 状态写入失败不影响主流程
    }
  }

  /** 公开只读访问器（Task-20261026-002）：调度器算读取窗口、/memory/status 展示均需读取状态 */
  async getState(): Promise<DreamingState> {
    return this.loadState();
  }

  /**
   * 记录一次执行结果（Task-20261026-002 D9）。
   * 只写 lastRunAt / lastSummary，不触碰 lastProcessedDay（后者由 run() 在全部天成功后推进）。
   */
  async recordRun(record: DreamingRunRecord): Promise<void> {
    await this.saveState({
      lastRunAt: new Date().toISOString(),
      lastSummary: { ...record },
    });
  }

  /** 状态文件路径：{L2 记忆目录}/.dreaming-state.json */
  private statePath(): string {
    return join(this.episodic.getMemoryDir(), '.dreaming-state.json');
  }

  /**
   * 推断候选事实的来源可信度（需求 20261110-001 D3）。
   * 优先采信模型显式标注的 source：它表达「事实是怎么来的」，比自评 confidence 更可靠；
   * 缺失时回落 confidence 映射，兼容旧候选与历史行为。
   */
  private inferProvenance(cand: {
    fact: string;
    confidence: number;
    source?: CandidateSource;
  }): Provenance {
    if (cand.source === 'user_stated') return 'owner_direct';
    if (cand.source === 'observed') return 'owner_derived';
    if (cand.source === 'inferred') return 'agent_inferred';
    // 回落：confidence >= 8 → owner_direct, 6-7 → owner_derived, ...
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
  private parseCandidates(content: string, result: DreamingResult): DreamingCandidate[] {
    // 清理可能的 markdown 代码块围栏
    const cleaned = content
      .replace(/```(?:json)?/g, '')
      .replace(/^\s*```\s*$/gm, '')
      .trim();
    let raw: unknown;
    try {
      // 尝试直接解析
      raw = JSON.parse(cleaned);
    } catch {
      // 尝试提取 JSON 块
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) return [];
      try {
        raw = JSON.parse(match[0]);
      } catch {
        /* 解析失败返回空 */
        return [];
      }
    }
    if (!Array.isArray(raw)) {
      result.warnings?.push('提取结果不是 JSON 数组，本次无候选事实');
      return [];
    }
    // 校验/归一：非法 targetFile、超长 fact、缺失字段都在这里兜住（不再静默丢弃）
    const { candidates, warnings } = normalizeCandidates(raw);
    if (warnings.length > 0) {
      if (!result.warnings) result.warnings = [];
      result.warnings.push(...warnings);
    }
    return candidates;
  }
}
