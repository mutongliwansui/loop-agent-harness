import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  access,
  readdir,
  unlink,
  rm,
} from 'node:fs/promises';
import type { ChatMessage } from '../types.js';
import type { SessionMeta, SessionData, WorkspaceMeta, WorkspaceSummary } from './types.js';
import { stripMemorySection } from '../memory/memory-section.js';
import { isSummaryMessage } from '../memory/summary-message.js';
import { encrypt, decrypt } from './crypto.js';
import { keychain } from './keychain.js';
import { debug } from '../debug.js';

/** 检查文件是否存在 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 生成工作空间 ID（路径 SHA-256 前 16 位） */
export function workspaceId(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

/** 格式化日期为文件名安全格式 */
function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 摘要占位消息的固定前缀（buildCompactedView 注入；落盘为总结消息时剥离） */
const SUMMARY_PLACEHOLDER_PREFIX = '[历史摘要]';

/** 会话数据文件缺失（索引有条目但落盘文件不存在，如存储被清理/跨扩展名切换） */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`会话不存在或已被删除: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}

/** 规范化一条运行时消息为可落盘形式：重算 is_compact/is_show/show_content/kind */
function toStoredMessage(
  m: ChatMessage,
  opts: { isCompact: boolean; isSummary?: boolean },
): ChatMessage {
  const out = { ...m } as ChatMessage;
  out.is_compact = m.role === 'system' ? false : opts.isCompact;
  out.is_show = m.role === 'system' ? false : opts.isSummary !== true;
  // 显式种类标记：总结消息写入 kind='summary'，其余消息清除（避免运行时残留标记误判）
  if (opts.isSummary === true && m.role !== 'system') out.kind = 'summary';
  else delete out.kind;
  if (m.role === 'user' && typeof m.content === 'string') {
    // content 为原始用户输入（存量数据可能含 L2 记忆前缀）；展示内容单独存 show_content
    const stripped = stripMemorySection(m.content);
    if (stripped !== m.content) out.show_content = stripped;
  }
  return out;
}

/** 从摘要占位/总结消息里取纯净摘要文本（去掉 [历史摘要] 前缀） */
function extractSummaryText(placeholder: ChatMessage): string {
  const text = typeof placeholder.content === 'string' ? placeholder.content : '';
  return text.startsWith(SUMMARY_PLACEHOLDER_PREFIX)
    ? text.slice(SUMMARY_PLACEHOLDER_PREFIX.length).trim()
    : text.trim();
}

// 检查两条消息是否重复（考虑所有关键字段）
// user 消息按「剥离 L2 记忆前缀后」的文本比较：存量会话可能落盘了带前缀的 content，
// 而运行时视图使用原始输入，严格比较会让锚点/去重全部失效。
function isSameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  const aContent = typeof a.content === 'string' ? a.content : '';
  const bContent = typeof b.content === 'string' ? b.content : '';
  if (a.role === 'user') {
    if (stripMemorySection(aContent) !== stripMemorySection(bContent)) return false;
  } else if (aContent !== bContent) {
    return false;
  }
  if (a.role === 'assistant' && b.role === 'assistant') {
    const aCalls = a.tool_calls ?? [];
    const bCalls = b.tool_calls ?? [];
    if (aCalls.length !== bCalls.length) return false;
    return aCalls.every((ac, i) => {
      const bc = bCalls[i];
      return ac.id === bc.id && ac.function.name === bc.function.name && ac.function.arguments === bc.function.arguments;
    });
  }
  if (a.role === 'tool' && b.role === 'tool') {
    return a.tool_call_id === b.tool_call_id;
  }
  return true;
}

/**
 * 在 base 的 [from, end) 区间里定位 kept 的起点（后缀锚点对齐）。
 * 取「从该位置起连续匹配条数最多」的位置：相同内容重复出现时，优先命中匹配链更长的那条，
 * 避免误命中旧归档副本（找不到就退化为追加，不靠全局内容去重吞消息）。
 * @returns index 起点下标（未命中为 -1）；run 从起点连续匹配的条数（0 表示未命中）
 */
function findKeptAnchor(
  base: ChatMessage[],
  kept: ChatMessage[],
  from: number,
): { index: number; run: number } {
  let index = -1;
  let run = 0;
  if (kept.length === 0) return { index, run };
  for (let i = Math.max(0, from); i < base.length; i++) {
    let n = 0;
    while (n < kept.length && i + n < base.length && isSameMessage(base[i + n], kept[n])) n++;
    if (n > run) {
      run = n;
      index = i;
    }
  }
  return { index, run };
}

/**
 * updateSession / createSession 的可选持久化参数
 */
export interface SessionUpdateOptions {
  /**
   * 本轮未经 L1 压缩的完整真实消息轨迹（不含 system 与摘要占位）。
   * 压缩轮次以此为准划分「归档 / recent」：本轮已被 compact() 从内存视图删除、
   * 但从未落盘的消息也会以 is_compact=true 归档，避免历史丢失。
   * 不传时退化为仅基于已落盘历史定位边界的旧行为。
   */
  transcript?: ChatMessage[];
}

/**
 * 在 transcript 中按引用定位 recent 各条消息，返回递增的 transcript 下标。
 * recent 必须是当前内存视图中保留的原始消息对象（与 transcript 同引用）；
 * 任一未命中（消息对象被重建）返回 null，调用方回退旧逻辑。
 */
function locateInTranscript(
  transcript: ChatMessage[],
  recent: ChatMessage[],
): number[] | null {
  const indices: number[] = [];
  for (const r of recent) {
    const idx = transcript.indexOf(r);
    if (idx < 0) return null;
    if (indices.length > 0 && idx <= indices[indices.length - 1]) return null;
    indices.push(idx);
  }
  return indices;
}

/**
 * prev 是否按顺序全部出现在 transcript 中（子序列匹配，忽略中间新增消息）。
 * 用于校验「已落盘的 recent 历史都被完整带入了本轮轨迹」，避免调用方裁剪历史后重建丢消息。
 */
function coversInOrder(prev: ChatMessage[], transcript: ChatMessage[]): boolean {
  let j = 0;
  for (const p of prev) {
    while (j < transcript.length && !isSameMessage(transcript[j], p)) j++;
    if (j >= transcript.length) return false;
    j++;
  }
  return true;
}

/**
 * 识别 prevArchived 末尾有多少条属于本轨迹（上次快照写入的归档）。
 * 同一 run 的归档总是追加在末尾，且内容按轨迹顺序取自当前 dropped（压缩只会单调丢弃，
 * 上次的 dropped 必为本次 dropped 的有序子集）。从尾部倒序匹配，命中即视为可复用条目；
 * 一旦匹配中断就停止（宁可少识别、多保留，也不误删历史归档）。
 */
function countReplayedArchive(prevArchived: ChatMessage[], dropped: ChatMessage[]): number {
  let count = 0;
  let cursor = dropped.length - 1;
  for (let k = prevArchived.length - 1; k >= 0; k--) {
    let hit = -1;
    for (let t = cursor; t >= 0; t--) {
      if (isSameMessage(dropped[t], prevArchived[k])) {
        hit = t;
        break;
      }
    }
    if (hit < 0) break;
    cursor = hit - 1;
    count++;
  }
  return count;
}

/**
 * 防膨胀封顶：优先丢弃最老的归档消息（is_compact=true），
 * 其次丢弃最老的非总结消息；总结消息与 recent 尽量保留（旧实现 slice(-4000) 会把总结一起截掉）。
 */
function capStoredMessages(list: ChatMessage[], max: number): ChatMessage[] {
  if (list.length <= max) return list;
  let excess = list.length - max;

  // 阶段 1：从头部丢归档消息
  const stage1: ChatMessage[] = [];
  for (const m of list) {
    if (excess > 0 && m.is_compact === true) {
      excess--;
      continue;
    }
    stage1.push(m);
  }
  if (excess === 0) return stage1;

  // 阶段 2：仍超限 → 保留总结消息，从头部丢非总结消息
  const stage2: ChatMessage[] = [];
  for (const m of stage1) {
    if (excess > 0 && !isSummaryMessage(m)) {
      excess--;
      continue;
    }
    stage2.push(m);
  }
  if (excess === 0) return stage2;

  // 阶段 3：极端情况（仅剩总结）→ 从头截断
  return stage2.slice(excess);
}

/** 日志用：单条消息摘要（角色/长度/标记 + 内容截断），避免把全文写进日志 */
function describeMessage(m: ChatMessage, index?: number): string {
  const text = typeof m.content === 'string' ? m.content : '';
  const flags = `is_compact=${m.is_compact === true} is_show=${m.is_show !== false}`;
  const pos = index === undefined ? '' : `#${index} `;
  const preview = text.replace(/\s+/g, ' ').slice(0, 60);
  return `${pos}${m.role}(${text.length}字, ${flags}) ${preview}`;
}

export class SessionStore {
  private workspacePath: string;
  private workspaceId: string;
  private workspaceDir: string;
  private readonly userDir: string;
  private currentSessionId: string | null = null;
  /** 是否启用加密存储 */
  private readonly encryptionEnabled: boolean;

  // 共享默认值：CLI 单空间时不传参数，即以启动目录为空间根；serve 侧由 runtime 构造时显式传根
  constructor(
    workspacePath: string = process.cwd(),
    encryptionEnabled = true,
    userDir: string = join(homedir(), '.loop-agent'),
  ) {
    this.userDir = userDir;
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId(workspacePath);
    this.workspaceDir = join(userDir, 'sessions', this.workspaceId);
    this.encryptionEnabled = encryptionEnabled;
  }

  /** 当前会话 ID */
  get currentId(): string | null {
    return this.currentSessionId;
  }

  /** 当前工作空间 ID */
  get id(): string {
    return this.workspaceId;
  }

  /** 是否启用加密存储 */
  get isEncrypted(): boolean {
    return this.encryptionEnabled;
  }

  /** 当前工作空间路径 */
  get path(): string {
    return this.workspacePath;
  }

  /**
   * 会话文件所在的工作空间存储目录（<userDir>/sessions/<workspaceId>，Task-20261021-002-06）。
   * run journal 等会话附属文件据此同根存放，随会话/空间清理天然联动。
   */
  get sessionsDir(): string {
    return this.workspaceDir;
  }

  /** 跨空间定位会话文件所在目录（找不到回退当前空间目录）；journal 读写删除联动用 */
  async sessionDirOf(id: string): Promise<string> {
    return this.resolveWorkspaceDir(id);
  }

  /**
   * 初始化：加密模式下确保密钥已加载，创建目录
   */
  async init(): Promise<void> {
    if (this.encryptionEnabled) {
      keychain.ensureUnlocked();
    }
    await mkdir(this.workspaceDir, { recursive: true });
    await this.touchWorkspaceMeta();
  }

  /**
   * 创建新会话：messages 直接落盘（含 system），标记规范化后写入索引。
   * 与 updateSession 压缩分支对齐：传入消息含摘要占位（kind='summary' 或旧的
   * is_show=false user 消息，首轮即触发 L1 压缩）时，占位原位转写为总结消息
   * （剥离 [历史摘要] 前缀），避免摘要丢失。
   * 传入 opts.transcript 时，轮内已被压缩丢弃、从未落盘的消息按 is_compact=true 归档。
   */
  async createSession(
    firstMessage: string,
    messages: ChatMessage[],
    opts?: SessionUpdateOptions,
  ): Promise<SessionMeta> {
    // Task-20261021-010-04（D5）：id 加空间命名空间 sess_<wsId8>_<ts>，
    // 跨空间同秒创建不再撞名（RunHub/SessionManager 以 id 为全局键）；
    // 老格式 sess_<ts> 永久兼容读取（session-locator 全扫回退定位）。
    const id = `sess_${this.workspaceId.slice(0, 8)}_${formatDate(new Date())}`;
    const now = new Date().toISOString();

    const stored: ChatMessage[] = [];
    const summaryPlaceholder = messages.find((m) => isSummaryMessage(m));
    const transcript = opts?.transcript?.filter(
      (m) => m.role !== 'system' && !isSummaryMessage(m),
    );
    const incomingKept = messages.filter((m) => m.role !== 'system' && !isSummaryMessage(m));
    const recentIdx =
      summaryPlaceholder && transcript?.length
        ? locateInTranscript(transcript, incomingKept)
        : null;

    if (summaryPlaceholder && transcript?.length && recentIdx) {
      // 压缩轮次：以完整轨迹为准，未被保留的消息全部归档（含本轮已从内存视图删除的消息）
      const system = messages.find((m) => m.role === 'system');
      if (system) stored.push(toStoredMessage(system, { isCompact: false }));
      const recentSet = new Set(recentIdx);
      transcript.forEach((m, idx) => {
        if (!recentSet.has(idx)) stored.push(toStoredMessage(m, { isCompact: true }));
      });
      stored.push(
        toStoredMessage(
          { role: 'user', content: extractSummaryText(summaryPlaceholder) },
          { isCompact: false, isSummary: true },
        ),
      );
      for (const idx of recentIdx) {
        stored.push(toStoredMessage(transcript[idx], { isCompact: false }));
      }
      debug.log(
        `[createSession ${id}] 压缩轮次 轨迹=${transcript.length}条 ` +
          `归档=${transcript.length - recentIdx.length}条 recent=${recentIdx.length}条 ` +
          `摘要=${extractSummaryText(summaryPlaceholder).length}字`,
      );
    } else {
      for (const m of messages) {
        if (isSummaryMessage(m)) {
          stored.push(
            toStoredMessage(
              { role: 'user', content: extractSummaryText(m) },
              { isCompact: false, isSummary: true },
            ),
          );
        } else {
          stored.push(toStoredMessage(m, { isCompact: false }));
        }
      }
    }

    const data: SessionData = {
      id,
      createdAt: now,
      updatedAt: now,
      messages: stored,
    };

    await this.writeSession(data);
    const meta = this.toMeta(data, firstMessage);
    await this.appendIndex(meta);
    this.currentSessionId = id;
    return meta;
  }

  /**
   * 更新会话：以已有全量历史为底，按后缀锚点对齐后追加本次新消息。
   * - 未压缩轮次：保留已有条目的标记，只追加锚点之后的新消息（重复内容是合法消息，不去重）
   * - 本轮发生 L1 压缩（messages 中出现摘要占位：kind='summary' / is_show=false 的 user 消息）：重建标记——
   *   边界之前的消息标记 is_compact=true（折叠进摘要），写入新的总结消息（kind='summary'、is_show=false、role=user），
   *   边界之后（压缩后保留的最近轮次）标记 is_compact=false。边界只会在上一轮 recent 区内定位，
   *   锚点未命中时保守归档旧历史（kept 全部保留为 recent），不会丢消息。
   * @param firstUserMessage 调用方持有的本次原始用户输入（可选）。会话标题缺失时优先用它生成——
   *   messages 可能已被 L1 压缩重写（首问被摘要替换），从消息推断不可靠。
   * @returns 归一化后的会话消息（全量历史，含 system 及 is_compact/is_show/show_content 标记），
   *   调用方可直接用作下一轮基线（摘要占位已转写为总结消息）
   */
  async updateSession(
    id: string,
    messages: ChatMessage[],
    firstUserMessage?: string,
    opts?: SessionUpdateOptions,
  ): Promise<ChatMessage[]> {
    const startedAt = Date.now();
    const log = (msg: string): void => debug.log(`[updateSession ${id}] ${msg}`);

    const data = await this.readSession(id);
    const prev = data.messages ?? [];

    const system = messages.find((m) => m.role === 'system') ?? prev.find((m) => m.role === 'system');
    const prevNonSystem = prev.filter((m) => m.role !== 'system');
    // 本次传入的非 system 真实消息（去掉摘要占位）
    const incomingKept = messages.filter((m) => m.role !== 'system' && !isSummaryMessage(m));
    // 本轮是否发生压缩：由 compact() 注入的摘要占位（kind='summary'，旧数据回退 is_show=false user）标识
    const summaryPlaceholder = messages.find((m) => isSummaryMessage(m));

    log(
      `入口 传入=${messages.length}条 已有=${prev.length}条 传入非system=${incomingKept.length}条 ` +
        `已有非system=${prevNonSystem.length}条 system=${system ? '有' : '无'} ` +
        `摘要占位=${summaryPlaceholder ? `有(${extractSummaryText(summaryPlaceholder).length}字, @${messages.indexOf(summaryPlaceholder)})` : '无'}`,
    );

    let nextNonSystem: ChatMessage[];
    if (summaryPlaceholder) {
      // 压缩轮次：丢弃旧总结消息（被新总结取代），以全量历史重建压缩边界
      const base = prevNonSystem.filter((m) => !isSummaryMessage(m));
      const kept = incomingKept.filter((m) => !isSummaryMessage(m));
      // 锚点只能在「上一轮的 recent 区」里找：边界不得早于此处，
      // 否则旧归档消息会被误标成 recent（P1-a）
      const prevRecentStart = base.findIndex((m) => m.is_compact !== true);
      const from = prevRecentStart < 0 ? base.length : prevRecentStart;
      const summaryMsg = toStoredMessage(
        { role: 'user', content: extractSummaryText(summaryPlaceholder) },
        { isCompact: false, isSummary: true },
      );

      // 优先用调用方传入的完整轨迹划分归档/recent：压缩会在 run 过程中物理删除消息，
      // 仅凭内存视图无法还原「本轮已被压缩、但从未落盘」的消息。
      // kept 与 transcript 须为同一批对象（compact() 保留原引用），按引用定位。
      const transcript = opts?.transcript?.filter(
        (m) => m.role !== 'system' && !isSummaryMessage(m),
      );
      const prevArchived = base.filter((m) => m.is_compact === true);
      const prevRecent = base.filter((m) => m.is_compact !== true);
      const keptIdx = transcript?.length ? locateInTranscript(transcript, kept) : null;
      // 安全前提：已落盘的 recent 必须完整出现在 transcript 里（按序子序列），
      // 否则说明调用方传入的历史有裁剪，重建会丢消息 → 回退 legacy
      const prevCovered = transcript?.length ? coversInOrder(prevRecent, transcript) : false;
      let rebuilt: ChatMessage[] | null = null;

      if (transcript && keptIdx && prevCovered) {
        const keptSet = new Set(keptIdx);
        // 轨迹中本次未保留的全部消息（含本轮压缩后已从内存视图删除的）
        const dropped = transcript.filter((_, idx) => !keptSet.has(idx));
        // 同一次 run 内可能发生多次压缩快照：上次快照写入的归档条目仍在本轨迹里，
        // 需要从已有归档尾部识别并替换，避免重复落盘
        const replayed = countReplayedArchive(prevArchived, dropped);
        const keptArchived = prevArchived.slice(0, prevArchived.length - replayed);
        const compacted = [
          ...keptArchived,
          ...dropped,
        ].map((m) => toStoredMessage(m, { isCompact: true }));
        const recent = keptIdx.map((idx) => toStoredMessage(transcript[idx], { isCompact: false }));
        rebuilt = [...compacted, summaryMsg, ...recent];
        log(
          `压缩轮次(轨迹) 已有归档=${prevArchived.length}条(其中本轮重复${replayed}条) ` +
            `已有recent=${prevRecent.length}条 轨迹=${transcript.length}条 kept=${kept.length}条`,
        );
        log(
          `本次归档轨迹未保留=${dropped.length}条（含本轮已从内存视图删除、尚未落盘的消息）`,
        );
        log(
          `结果 compacted=${compacted.length}条 + summary=${extractSummaryText(summaryPlaceholder).length}字 + recent=${recent.length}条 ` +
            `=> ${rebuilt.length}条`,
        );
      } else if (transcript?.length) {
        log(
          `⚠ transcript 重建失败（${keptIdx ? '已落盘 recent 未完整包含于轨迹' : '无法按引用定位 recent，消息对象被重建'}），` +
            `回退 legacy 边界逻辑`,
        );
      }

      if (!rebuilt) {
        // 回退：仅基于已落盘历史做后缀锚点对齐（旧行为）
        const anchor = findKeptAnchor(base, kept, from);
        // 锚点命中 → 只追加锚点之后的新消息；未命中 → kept 全部视为新消息追加（不丢消息）
        const appended = anchor.run > 0 ? kept.slice(anchor.run) : kept;
        const full: ChatMessage[] = [...base, ...appended];
        // 边界 = kept 起点；未命中时保守取 base 尾部（只归档旧历史，kept 全部保留为 recent，
        // 不再把 kept 一起折叠导致下一轮只剩总结——P2-a）
        const boundary = anchor.run > 0 ? anchor.index : base.length;

        const compacted = full.slice(0, boundary).map((m) => toStoredMessage(m, { isCompact: true }));
        const recent = full.slice(boundary).map((m) => toStoredMessage(m, { isCompact: false }));
        rebuilt = [...compacted, summaryMsg, ...recent];

        log(
          `压缩轮次(legacy) base=${base.length}条(丢弃旧总结${prevNonSystem.length - base.length}条) ` +
            `kept=${kept.length}条(锚点命中${anchor.run}条, 追加${appended.length}条) full=${full.length}条`,
        );
        log(
          `边界 boundary=${boundary} anchor=${anchor.index} ` +
            (anchor.run > 0
              ? `保留首条 ${describeMessage(full[boundary], boundary)}`
              : `⚠ 锚点未命中(搜索起点=${from})，保守归档旧历史，kept 全部保留为 recent`),
        );
        if (boundary > 0) log(`折叠末条 ${describeMessage(full[boundary - 1], boundary - 1)}`);
        log(
          `结果 compacted=${compacted.length}条 + summary=${extractSummaryText(summaryPlaceholder).length}字 + recent=${recent.length}条 ` +
            `=> ${rebuilt.length}条`,
        );
      }
      nextNonSystem = rebuilt;
    } else {
      // 未压缩轮次：保留已有条目（含其标记），按后缀锚点对齐后只追加新消息
      const prevRecentStart = prevNonSystem.findIndex((m) => m.is_compact !== true);
      const from = prevRecentStart < 0 ? prevNonSystem.length : prevRecentStart;
      const anchor = findKeptAnchor(prevNonSystem, incomingKept, from);
      // 不做全局内容去重：重复内容（如用户重发「继续」）是合法消息，只按锚点区分新旧（P1-b）
      const appended = anchor.run > 0 ? incomingKept.slice(anchor.run) : incomingKept;
      nextNonSystem = [
        ...prevNonSystem,
        ...appended.map((m) => toStoredMessage(m, { isCompact: false })),
      ];
      // 防膨胀：极端情况封顶（优先丢弃最老的归档消息，避免把总结消息一起截掉）
      const beforeCap = nextNonSystem.length;
      if (nextNonSystem.length > 4000) nextNonSystem = capStoredMessages(nextNonSystem, 4000);
      log(
        `未压缩轮次 已有=${prevNonSystem.length}条 锚点命中=${anchor.run}条 新增=${appended.length}条 ` +
          `(传入${incomingKept.length}条) 合计=${beforeCap}条` +
          `${beforeCap > 4000 ? `（超限封顶为4000，丢弃${beforeCap - nextNonSystem.length}条）` : ''}`,
      );
    }

    data.messages = system
      ? [toStoredMessage(system, { isCompact: false }), ...nextNonSystem]
      : nextNonSystem;
    data.updatedAt = new Date().toISOString();

    await this.writeSession(data);
    log(
      `落盘完成 总=${data.messages.length}条(折叠=${data.messages.filter((m) => m.is_compact === true).length}条, ` +
        `不展示=${data.messages.filter((m) => m.role !== 'system' && m.is_show === false).length}条) ` +
        `写入=${Date.now() - startedAt}ms`,
    );
    // 会话标题：WebUI「先建空会话、后发消息」时 createSession 的 title 为空——用首条用户消息补生成（已有 title 不覆盖）
    const updates: Partial<Pick<SessionMeta, 'title' | 'messageCount' | 'updatedAt'>> = {
      messageCount: data.messages.length,
      updatedAt: data.updatedAt,
    };
    const current = (await this.readIndex()).find((m) => m.id === id);
    if (current && !current.title) {
      // 标题来源优先级：调用方显式传入的原始输入 > 消息推断（首条 user 可能带 L2 记忆前缀，需剥离；
      // 且 L1 压缩后首问可能已被摘要替换，故推断仅作 fallback）
      const explicit = firstUserMessage?.trim();
      const firstUser = messages.find((m) => m.role === 'user' && !isSummaryMessage(m));
      const text = explicit || (firstUser && typeof firstUser.content === 'string'
        ? stripMemorySection(firstUser.content).trim()
        : '');
      if (text) updates.title = text.slice(0, 50);
    }
    await this.updateIndex(id, updates);
    log(
      `索引更新 messageCount=${updates.messageCount}` +
        `${updates.title ? ` 标题="${updates.title}"` : ''}` +
        `${current ? '' : '（索引中未找到该会话，未写入）'}` +
        ` 总耗时=${Date.now() - startedAt}ms`,
    );
    return data.messages;
  }

  /**
   * 加载会话（仅支持新结构：单一 messages 数组 + per-message 标记）
   */
  async loadSession(id: string): Promise<SessionData> {
    const data = await this.readSession(id);
    this.currentSessionId = id;
    return data;
  }

  /**
   * 返回会话全量历史（含 system）。messages 已是唯一真源，
   * 展示层自行按 is_show 过滤（system 与压缩总结消息不展示）。
   */
  static getAllAvailableMessages(data: SessionData): ChatMessage[] {
    return data.messages ?? [];
  }

  /**
   * 获取用于恢复对话的消息：system（当前配置重建） + 所有 is_compact!==true 的消息。
   * 被压缩折叠进摘要的历史（is_compact=true）不参与上下文；摘要本身是一条
   * is_show=false、is_compact=false 的 user 消息，会自然进入上下文。
   * 输出不含历史 system（由调用方的 systemPrompt 决定）。
   */
  static getRestoreMessages(
    data: SessionData,
    systemPrompt?: string,
  ): ChatMessage[] {
    const result: ChatMessage[] = [];
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
    for (const m of data.messages ?? []) {
      if (m.role === 'system') continue;
      if (m.is_compact === true) continue;
      result.push(m);
    }
    return result;
  }

  /**
   * 列出当前工作空间的所有会话
   */
  async listSessions(): Promise<SessionMeta[]> {
    return this.readIndex();
  }

  /**
   * 聚合所有工作空间：扫描 <userDir>/sessions/* 下的 meta.json 与 sessions.json
   * （两者均为明文索引，无需解密）；按空间首次使用时间（createdAt）升序——顺序稳定，
   * 空间之间完全并列，不存在"当前空间"标记。
   * 旧 meta.json 无 workspaceName 时回退为工作路径目录名。
   */
  async listAllWorkspaces(): Promise<WorkspaceSummary[]> {
    const root = dirname(this.workspaceDir);
    let dirs: string[];
    try {
      dirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return []; // sessions 根目录不存在
    }
    const result: WorkspaceSummary[] = [];
    for (const dir of dirs) {
      const wsDir = join(root, dir);
      let meta: WorkspaceMeta;
      try {
        meta = JSON.parse(await readFile(join(wsDir, 'meta.json'), 'utf-8')) as WorkspaceMeta;
      } catch {
        continue; // meta.json 缺失或损坏：无归属信息，不展示
      }
      let sessions: SessionMeta[] = [];
      try {
        sessions = JSON.parse(await readFile(join(wsDir, 'sessions.json'), 'utf-8')) as SessionMeta[];
      } catch {
        // 索引缺失/损坏：展示空间本身，会话数为 0
      }
      result.push({
        id: dir,
        name: meta.workspaceName || basename(meta.workspacePath) || dir,
        path: meta.workspacePath,
        createdAt: meta.createdAt,
        lastAccessedAt: meta.lastAccessedAt,
        sessions: sessions.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
      });
    }
    // 顺序稳定：按空间首次使用时间升序（新空间追加在末尾），切换不改变排列
    return result.sort(
      (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
    );
  }

  /**
   * 删除会话
   */
  async deleteSession(id: string): Promise<void> {
    const found = await this.findSessionFile(id);
    if (found) {
      // 同目录下两种扩展名一并清理（加密开关切换可能留下另一扩展名的残留）
      for (const name of [`${id}.enc`, `${id}.json`]) {
        const filePath = join(found.dir, name);
        if (await fileExists(filePath)) {
          await unlink(filePath);
        }
      }
      await this.removeFromIndex(id, found.dir);
    } else {
      // 落盘文件已缺失：仍清理索引，避免僵尸条目
      await this.removeFromIndex(id);
    }
    if (this.currentSessionId === id) {
      this.currentSessionId = null;
    }
  }

  /**
   * 删除当前工作空间的全部会话
   */
  async deleteAllSessions(): Promise<void> {
    const sessions = await this.listSessions();
    for (const s of sessions) {
      await this.deleteSession(s.id);
    }
  }

  /**
   * 获取最近的会话（按 updatedAt 排序）
   */
  async getLatestSession(): Promise<SessionMeta | null> {
    const sessions = await this.listSessions();
    if (sessions.length === 0) return null;
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0];
  }

  // ===== 私有方法 =====

  private get sessionFileExt(): string {
    return this.encryptionEnabled ? '.enc' : '.json';
  }

  /**
   * 解析会话文件所在的工作空间目录：先查当前空间，未命中则扫描兄弟空间
   * （跨工作空间读取/删除用）；都未命中回退当前空间（新会话写入当前空间）。
   */
  private async resolveWorkspaceDir(id: string): Promise<string> {
    if (await fileExists(join(this.workspaceDir, `${id}${this.sessionFileExt}`))) {
      return this.workspaceDir;
    }
    const root = dirname(this.workspaceDir);
    try {
      for (const d of await readdir(root, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === this.workspaceId) continue;
        const candidate = join(root, d.name);
        if (await fileExists(join(candidate, `${id}${this.sessionFileExt}`))) {
          return candidate;
        }
      }
    } catch {
      // 根目录不可读：回退当前空间
    }
    return this.workspaceDir;
  }

  /**
   * 定位会话落盘文件：当前空间优先，其次兄弟空间（跨工作空间读取/删除用）。
   * 同时兼容 .enc/.json 两种扩展名——加密开关切换后旧会话仍可读。
   * 找不到返回 null（writeSession 落新盘时改走 resolveWorkspaceDir 回退当前空间）。
   */
  private async findSessionFile(
    id: string,
  ): Promise<{ dir: string; file: string; encrypted: boolean } | null> {
    const root = dirname(this.workspaceDir);
    const dirs = [this.workspaceDir];
    try {
      for (const d of await readdir(root, { withFileTypes: true })) {
        if (d.isDirectory() && d.name !== this.workspaceId) dirs.push(join(root, d.name));
      }
    } catch {
      // 根目录不可读：仅查当前空间
    }
    for (const dir of dirs) {
      for (const [name, encrypted] of [
        [`${id}.enc`, true],
        [`${id}.json`, false],
      ] as const) {
        const file = join(dir, name);
        if (await fileExists(file)) return { dir, file, encrypted };
      }
    }
    return null;
  }

  private async writeSession(data: SessionData): Promise<void> {
    const dir = await this.resolveWorkspaceDir(data.id);
    const filePath = join(dir, `${data.id}${this.sessionFileExt}`);
    let payload: string;
    if (this.encryptionEnabled) {
      const key = keychain.getKey();
      if (!key) {
        throw new Error('密钥未加载，无法保存会话');
      }
      payload = encrypt(data, key);
    } else {
      payload = JSON.stringify(data, null, 2);
    }
    // 原子写：先写同目录临时文件再 rename 覆盖，避免进程中途退出留下半截 JSON
    // （节流落盘会频繁写同一文件，非原子覆盖一旦被打断会直接损坏会话）
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, payload, 'utf-8');
      await rename(tmpPath, filePath);
    } catch (e) {
      await unlink(tmpPath).catch(() => {});
      throw e;
    }
  }

  private async readSession(id: string): Promise<SessionData> {
    const found = await this.findSessionFile(id);
    if (!found) {
      throw new SessionNotFoundError(id);
    }
    const raw = await readFile(found.file, 'utf-8');
    if (found.encrypted) {
      const key = keychain.getKey();
      if (!key) {
        throw new Error('密钥未加载，无法读取会话');
      }
      return decrypt<SessionData>(raw, key);
    }
    return JSON.parse(raw) as SessionData;
  }

  private async readIndex(): Promise<SessionMeta[]> {
    const indexFile = join(this.workspaceDir, 'sessions.json');
    if (!(await fileExists(indexFile))) {
      return [];
    }
    const content = await readFile(indexFile, 'utf-8');
    return JSON.parse(content) as SessionMeta[];
  }

  private async writeIndex(sessions: SessionMeta[]): Promise<void> {
    const indexFile = join(this.workspaceDir, 'sessions.json');
    await writeFile(indexFile, JSON.stringify(sessions, null, 2), 'utf-8');
  }

  private async appendIndex(meta: SessionMeta): Promise<void> {
    const sessions = await this.readIndex();
    sessions.push(meta);
    await this.writeIndex(sessions);
  }

  private async updateIndex(
    id: string,
    updates: Partial<Pick<SessionMeta, 'title' | 'messageCount' | 'updatedAt'>>,
    dir: string = this.workspaceDir,
  ): Promise<void> {
    const indexFile = join(dir, 'sessions.json');
    const sessions = (await fileExists(indexFile))
      ? (JSON.parse(await readFile(indexFile, 'utf-8')) as SessionMeta[])
      : [];
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], ...updates };
      await writeFile(indexFile, JSON.stringify(sessions, null, 2), 'utf-8');
    }
  }

  private async removeFromIndex(id: string, dir: string = this.workspaceDir): Promise<void> {
    const indexFile = join(dir, 'sessions.json');
    if (!(await fileExists(indexFile))) return;
    const sessions = JSON.parse(await readFile(indexFile, 'utf-8')) as SessionMeta[];
    const filtered = sessions.filter((s) => s.id !== id);
    await writeFile(indexFile, JSON.stringify(filtered, null, 2), 'utf-8');
  }

  private toMeta(data: SessionData, firstMessage: string): SessionMeta {
    const title = firstMessage.slice(0, 50);
    return {
      id: data.id,
      title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: data.messages?.length ?? 0,
      file: `${data.id}${this.sessionFileExt}`,
    };
  }

  private async touchWorkspaceMeta(): Promise<void> {
    const metaFile = join(this.workspaceDir, 'meta.json');
    const workspaceName = basename(this.workspacePath);
    let meta: WorkspaceMeta;
    if (await fileExists(metaFile)) {
      const content = await readFile(metaFile, 'utf-8');
      meta = JSON.parse(content) as WorkspaceMeta;
      meta.lastAccessedAt = new Date().toISOString();
      meta.workspaceName = workspaceName;
    } else {
      meta = {
        workspacePath: this.workspacePath,
        workspaceName,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      };
    }
    await writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
  }
}
