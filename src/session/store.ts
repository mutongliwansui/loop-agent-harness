import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { loopAgentHome } from '../user-home.js';
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rename,
  access,
  readdir,
  unlink,
  rm,
} from 'node:fs/promises';
import type { ChatMessage } from '../types.js';
import { isDisplayOnlyContent, isSubAgentResultContent } from '../types.js';
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

/**
 * 原子替换（rename）带退避重试。
 *
 * Windows 上「rename 覆盖一个正被并发 rename/打开的目标」会抛 EPERM/EBUSY/EACCES，
 * 直接失败就等于这一轮的会话数据没落盘（调用方看到异常，历史停在旧版本）；
 * 短暂退避后重试通常即成功。
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (retryable && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 10 * (i + 1)));
        continue;
      }
      throw e;
    }
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

/**
 * 原子写临时文件序号：仅靠 pid+毫秒在并发落盘时会撞名，
 * 两个 writeFile 交错截断会把旧 payload 尾段留在新 JSON 后面（文件被撕裂）。
 */
let tmpWriteSeq = 0;

/**
 * 解析明文会话 JSON。容忍尾部残留脏字节：命中「Unexpected non-whitespace character after JSON」时
 * 按有效前缀读取，避免历史撕裂文件导致会话完全打不开；前缀也非法则抛原始错误。
 *
 * 返回 `degraded=true` 表示发生了「前缀容错读取」（需求 20261107-007 S1）：
 * 读出的可能是**旧快照**而非完整历史，调用方不得把它当可信基线（写回前需备份原始文件）。
 */
function parseSessionJson(
  raw: string,
  file: string,
): { data: SessionData; degraded: boolean } {
  try {
    return { data: JSON.parse(raw) as SessionData, degraded: false };
  } catch (e) {
    const pos = Number(/position (\d+)/.exec((e as Error).message)?.[1]);
    if (Number.isFinite(pos) && pos > 0) {
      try {
        const data = JSON.parse(raw.slice(0, pos)) as SessionData;
        debug.log(
          `[session] ${file} 尾部有 ${raw.length - pos} 字节残留，已按有效前缀读取（历史可能不完整）`,
        );
        return { data, degraded: true };
      } catch {
        /* 前缀也非法：保留原始错误 */
      }
    }
    throw e;
  }
}

/** 进程内消息 ID 序号（配合时间戳与随机段，保证同进程内不撞） */
let msgIdSeq = 0;

/** 生成新消息 ID（需求 20261107-007 S2） */
function newMsgId(): string {
  msgIdSeq = (msgIdSeq + 1) % 1679616; // 36^4，循环后仍靠时间戳与随机段区分
  const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  return `msg_${Date.now().toString(36)}_${msgIdSeq.toString(36)}${rand}`;
}

/**
 * 旧数据（无 msgId）的确定性 ID：同一文件多次读取必须得到同一 ID，否则去重/替换全部失效。
 * 用「下标 + 角色 + tool_call_id + 内容」做哈希，不下发到 LLM。
 */
function legacyMsgId(index: number, m: ChatMessage): string {
  const content = typeof m.content === 'string' ? m.content : '';
  const extra = m.role === 'tool' ? m.tool_call_id : '';
  const h = createHash('sha256')
    .update(`${index}|${m.role}|${extra}|${content}`)
    .digest('hex')
    .slice(0, 10);
  return `msg_l${h}`;
}

/**
 * 补齐旧数据缺失的消息 ID 并消解同文件内冲突（需求 20261107-007 S2）。
 * 冲突场景：旧文件里已有「重复段」（历史 bug 留下的副本）时，内容哈希可能相同，
 * 这里给后续副本追加 `_n` 序号，保证 ID 唯一（去重只认 ID，不认内容）。
 */
function ensureMsgIds(data: SessionData, id: string): SessionData {
  let filled = 0;
  const seen = new Set<string>();
  for (let idx = 0; idx < (data.messages ?? []).length; idx++) {
    const m = data.messages[idx];
    if (!m.msgId) {
      m.msgId = legacyMsgId(idx, m);
      filled++;
    }
    if (seen.has(m.msgId)) {
      let n = 2;
      while (seen.has(`${m.msgId}_${n}`)) n++;
      m.msgId = `${m.msgId}_${n}`;
    }
    seen.add(m.msgId);
  }
  if (filled > 0) {
    debug.log(`[session ${id}] 补生成消息 ID ${filled} 条（旧数据无 msgId）`);
  }
  return data;
}

/**
 * 按 msgId 去重（需求 20261107-007 S2）：保留首次出现，丢弃后续同 ID 副本。
 * 这是「历史回退后把同一批消息重复追加」的直接防线；
 * 内容相同的合法消息（连发两次「继续」）ID 不同，不会被吞。
 */
function dedupeByMsgId(messages: ChatMessage[]): { messages: ChatMessage[]; removed: number } {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  let removed = 0;
  for (const m of messages) {
    if (m.msgId) {
      if (seen.has(m.msgId)) {
        removed++;
        continue;
      }
      seen.add(m.msgId);
    }
    out.push(m);
  }
  return { messages: out, removed };
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
  // 消息稳定 ID（需求 20261107-007 S2）：已有则沿用（同一条消息多次落盘 ID 不变，是幂等去重的身份键）；
  // 新消息在此分配，随落盘固化，后续轮次/恢复都以该 ID 识别「同一条消息」
  if (!out.msgId) {
    out.msgId = newMsgId();
    // 回写给内存源对象（需求 20261107-011 回归）：一次 run 内会被多个快照反复落盘，
    // 只在副本上分配 ID 的话每次落盘都会得到新 ID，锚点未命中时同一消息会以不同 ID
    // 重复追加，msgId 去重完全失效（用户现象：只说一次「提交推送吧」却存了好几条）。
    m.msgId = out.msgId;
  }
  out.is_compact = m.role === 'system' ? false : opts.isCompact;
  out.is_show = m.role === 'system' ? false : opts.isSummary !== true;
  // 显式种类标记：总结消息写入 kind='summary'，其余消息清除（避免运行时残留标记误判）
  if (opts.isSummary === true && m.role !== 'system') out.kind = 'summary';
  // 需求 20261108-003：按内容特征补回展示专用消息的 kind 标记——
  // 全量重写（压缩轨迹重建/legacy 回退）会把磁盘历史重新 map(toStoredMessage)，
  // 旧实现走 else delete out.kind 把卡片标记抹掉，前端（认 kind）进不了卡片分支，
  // <subagent_result> 原文被当普通文本渲染（模型侧不受影响：getRestoreMessages 按内容过滤）。
  else if (m.role === 'user' && isSubAgentResultContent(out.content)) out.kind = 'subagent_result';
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
  /**
   * 曾以「尾部残留容错」方式降级读取过的会话（需求 20261107-007 S1）：
   * 这类会话读出的历史可能是旧快照，写回前必须备份原始文件，避免回退历史把原文件彻底覆盖。
   */
  private readonly degradedSessions = new Set<string>();
  /**
   * 同会话写操作串行化（需求 20261107-007 S2）：updateSession / rewriteMessages 都是
   * 「读文件 → 内存合并 → 写回」的 read-modify-write，两个调用并发交错会互相覆盖，
   * 表现为「刚落盘的消息又消失」或被当成新消息重复追加（重复段成因之一）。
   */
  private readonly sessionLocks = new Map<string, Promise<void>>();

  /** 在同一会话的写锁内执行（前序失败不阻塞后续） */
  private async withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionLocks.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.sessionLocks.get(id) === tail) this.sessionLocks.delete(id);
    }
  }

  // 共享默认值：CLI 单空间时不传参数，即以启动目录为空间根；serve 侧由 runtime 构造时显式传根
  constructor(
    workspacePath: string = process.cwd(),
    encryptionEnabled = true,
    userDir: string = loopAgentHome(),
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

  /**
   * 该会话最近一次读取是否走了「尾部残留容错」降级路径（需求 20261107-007 S1）。
   * true 表示读到的历史可能是旧快照（不完整）；调用方可据此提示用户，
   * 写入侧已由 store 自动备份原始文件（`.torn`）兜底。
   */
  isDegraded(id: string): boolean {
    return this.degradedSessions.has(id);
  }

  /**
   * 把会话文件当前的原始字节复制为 `.torn` 快照（已存在则不覆盖）。
   * 仅在降级会话写回前调用一次，保证「回退后的历史」覆盖文件后仍能取回原始数据。
   */
  private async backupTornFile(id: string): Promise<void> {
    const found = await this.findSessionFile(id);
    if (!found) return;
    const target = `${found.file}.torn`;
    if (await fileExists(target)) return;
    try {
      await copyFile(found.file, target);
      debug.log(`[session ${id}] 降级恢复：原始文件已备份为 ${target}`);
    } catch (e) {
      debug.log(`[session ${id}] 撕裂文件备份失败: ${(e as Error).message}`);
    }
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
      // 按轨迹原始下标升序落盘（需求 20261029-003）：归档/保留只由 is_compact 区分，
      // 磁盘顺序必须等于原始轨迹顺序。早前「先归档全部 dropped、再摘要、最后 recent」的写法，
      // 在 planCompaction 单轮 token 截尾 + 任务锚点 pin 场景下会把被 pin 的当前轮 user
      // 排到它引发的整段归档消息之后（用户消息错位）。
      stored.push(
        toStoredMessage(
          { role: 'user', content: extractSummaryText(summaryPlaceholder) },
          { isCompact: false, isSummary: true },
        ),
      );
      transcript.forEach((m, idx) => {
        stored.push(toStoredMessage(m, { isCompact: !recentSet.has(idx) }));
      });
      debug.log(
        `[createSession ${id}] 压缩轮次 轨迹=${transcript.length}条 ` +
          `归档=${transcript.length - recentIdx.length}条 recent=${recentIdx.length}条 ` +
          `摘要=${extractSummaryText(summaryPlaceholder).length}字（已按轨迹下标升序落盘）`,
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
    // 同会话串行化：并发交错会互相覆盖/重复追加（需求 20261107-007 S2）
    return this.withSessionLock(id, () =>
      this.updateSessionLocked(id, messages, firstUserMessage, opts),
    );
  }

  /** updateSession 的实际实现（调用方必须经 updateSession 进入，以保证串行化） */
  private async updateSessionLocked(
    id: string,
    messages: ChatMessage[],
    firstUserMessage?: string,
    opts?: SessionUpdateOptions,
  ): Promise<ChatMessage[]> {
    const startedAt = Date.now();
    const log = (msg: string): void => debug.log(`[updateSession ${id}] ${msg}`);

    const data = await this.readSession(id);
    const prev = data.messages ?? [];

    // 降级会话（文件曾撕裂、按有效前缀读取）写回前先备份原始字节（需求 20261107-007 S1）：
    // 读到的可能是旧快照，若不备份就覆盖写，「原始撕裂文件」将永久丢失
    if (this.degradedSessions.has(id)) {
      await this.backupTornFile(id);
      this.degradedSessions.delete(id);
    }

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
        // 按 transcript 原始下标升序重建本轮轨迹（需求 20261029-003）：
        // 归档(is_compact=true) 与保留(is_compact=false) 只在标记上区分，磁盘顺序必须等于原始轨迹顺序。
        // 早前按「先 dropped 后 kept」拼接，在 planCompaction 的「单轮 token 截尾 + 任务锚点 pin」场景下，
        // 被 pin 的当前轮 user 是 kept 首条但下标更靠前，会被排到它引发的那一整段归档消息之后，
        // 落盘后表现为用户消息错位（webui/CLI 按磁盘顺序平铺渲染）。压缩语义与恢复集合均不变。
        const ordered = transcript.map((m, idx) =>
          toStoredMessage(m, { isCompact: !keptSet.has(idx) }),
        );
        rebuilt = [...keptArchived, summaryMsg, ...ordered];
        log(
          `压缩轮次(轨迹) 已有归档=${prevArchived.length}条(其中本轮重复${replayed}条) ` +
            `已有recent=${prevRecent.length}条 轨迹=${transcript.length}条 kept=${kept.length}条`,
        );
        log(
          `本次归档轨迹未保留=${dropped.length}条（含本轮已从内存视图删除、尚未落盘的消息）`,
        );
        log(
          `结果 compacted=${keptArchived.length + dropped.length}条 + summary=${extractSummaryText(summaryPlaceholder).length}字 + recent=${keptIdx.length}条 ` +
            `=> ${rebuilt.length}条（已按轨迹下标升序重排）`,
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
    // 幂等防线（需求 20261107-007 S2）：同一 msgId 只保留首条。
    // 历史因撕裂回退到旧快照后，内存基线里的消息会被当成「新消息」再追加一遍，
    // 靠 ID 识别出它们是同一条消息并丢弃副本，重复段不再滚雪球。
    const deduped = dedupeByMsgId(data.messages);
    if (deduped.removed > 0) {
      log(
        `⚠ 按 msgId 去重：丢弃 ${deduped.removed} 条重复消息（历史回退/重复追加所致），` +
          `保留 ${deduped.messages.length} 条`,
      );
      data.messages = deduped.messages;
    }
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
   * 用 messages 覆盖会话消息数组（需求 20261106-005 D14：仅用于「重试」截断）。
   *
   * 与 updateSession 的区别：
   * - **不做**增量合并 / 压缩轨迹重建——重试是人为删除尾部消息，走合并逻辑会被当成
   *   「新消息」重新追加，已删内容又回到磁盘；
   * - 调用方传入的就是要落盘的完整数组（可含 system 与 is_compact 归档前缀），原样写入。
   *
   * 同步更新 messageCount / updatedAt；截断后若已无用户消息，标题重置为空。
   */
  async rewriteMessages(id: string, messages: ChatMessage[]): Promise<ChatMessage[]> {
    // 同会话串行化：与 updateSession 共用一把锁，避免互相覆盖（需求 20261107-007 S2）
    return this.withSessionLock(id, () => this.rewriteMessagesLocked(id, messages));
  }

  /** rewriteMessages 的实际实现（调用方必须经 rewriteMessages 进入，以保证串行化） */
  private async rewriteMessagesLocked(
    id: string,
    messages: ChatMessage[],
  ): Promise<ChatMessage[]> {
    const startedAt = Date.now();
    const data = await this.readSession(id);
    if (this.degradedSessions.has(id)) {
      await this.backupTornFile(id);
      this.degradedSessions.delete(id);
    }
    // 幂等防线（需求 20261107-007 S2）：覆盖写前也按 msgId 去重——
    // 调用方传入的数组若由「旧快照 + 追加」拼出，同 ID 副本会在此被收敛。
    const deduped = dedupeByMsgId(messages);
    if (deduped.removed > 0) {
      debug.log(
        `[rewriteMessages ${id}] 按 msgId 去重：丢弃 ${deduped.removed} 条重复消息`,
      );
    }
    // 补 msgId（S2）：覆盖写不改变内容，但新消息必须带稳定 ID，
    // 否则后续轮次无法识别「同一条消息」，去重与恢复链路失效
    data.messages = deduped.messages.map((m) => (m.msgId ? m : { ...m, msgId: newMsgId() }));
    data.updatedAt = new Date().toISOString();
    await this.writeSession(data);

    const updates: Partial<Pick<SessionMeta, 'title' | 'messageCount' | 'updatedAt'>> = {
      messageCount: data.messages.length,
      updatedAt: data.updatedAt,
    };
    const hasUser = data.messages.some(
      (m) => m.role === 'user' && !isSummaryMessage(m) && m.is_show !== false,
    );
    if (!hasUser) updates.title = '';
    await this.updateIndex(id, updates);
    debug.log(
      `[rewriteMessages ${id}] 覆盖写入 ${data.messages.length} 条（重试截断）` +
        ` 写入=${Date.now() - startedAt}ms`,
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
   * 进程重启后，把仍处于 running 状态的后台子任务卡片标记为 interrupted。
   *
   * 仅在 SessionManager.ensureEntry 冷启动路径（缓存 miss）调用一次，
   * 避免误标当前进程内正在运行的子任务。返回被修改的卡片数量。
   *
   * 修改内容：status: running → status: interrupted；error 置为「进程重启，后台子任务未完成」。
   * 定位 running 卡片用 /^status: running$/m；error 行锚定到 </subagent_result> 前一行，
   * 防止误替换 task / answer 正文中出现的 error: 文本。
   */
  async markRunningSubAgentsInterrupted(id: string): Promise<number> {
    const data = await this.readSession(id);
    let changed = 0;
    for (const m of data.messages ?? []) {
      if (m.role !== 'user' || !isSubAgentResultContent(m.content)) continue;
      const content = m.content ?? '';
      if (!/^status: running$/m.test(content)) continue;
      m.content = content
        .replace(/^status: running$/m, 'status: interrupted')
        .replace(
          /^error:.*\n<\/subagent_result>/m,
          'error: 进程重启，后台子任务未完成\n</subagent_result>',
        );
      changed++;
    }
    if (changed > 0) {
      data.updatedAt = new Date().toISOString();
      await this.writeSession(data);
      debug.log(
        `[markRunningSubAgentsInterrupted ${id}] 标记 ${changed} 张 running 卡片为 interrupted`,
      );
    }
    return changed;
  }

  /**
   * 存量脏数据修复（需求 20261108-003）：
   * 旧版 toStoredMessage 在全量重写（压缩轨迹重建/legacy 回退）时无条件 delete out.kind，
   * 后台子任务结果卡片的 kind='subagent_result' 标记被抹掉——后端按内容特征仍能正确
   * 过滤 LLM 上下文，但前端（只认 kind）进不了卡片分支，<subagent_result> 原文被
   * 当普通文本渲染到界面上。本方法按内容特征（isSubAgentResultContent，容忍记忆前缀
   * 包裹）补回标记，与内容判据天然幂等。
   *
   * 仅在 SessionManager.ensureEntry 冷启动路径（缓存 miss）调用一次，
   * 与 markRunningSubAgentsInterrupted 同模式，避免与运行中写入竞争。返回修复条数。
   */
  async repairSubAgentCardKinds(id: string): Promise<number> {
    const data = await this.readSession(id);
    let changed = 0;
    for (const m of data.messages ?? []) {
      if (m.role !== 'user' || m.kind === 'subagent_result') continue;
      if (!isSubAgentResultContent(m.content)) continue;
      m.kind = 'subagent_result';
      changed++;
    }
    if (changed > 0) {
      data.updatedAt = new Date().toISOString();
      await this.writeSession(data);
      debug.log(`[repairSubAgentCardKinds ${id}] 补回 ${changed} 张卡片的 kind 标记`);
    }
    return changed;
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
      // 需求 20261105-001 D9 + 20261107-002 D8：后台任务通知 / 子 Agent 结果卡片
      // 仅用于界面展示，不进入 LLM 历史前缀（含旧版本已落盘的、被记忆前缀包裹的遗留通知）
      if (m.role === 'user' && isDisplayOnlyContent(m.content)) continue;
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
   * 写入会话级模型选择（task-20261025-002 D7）
   *
   * 刻意**不**复用 updateSession：那条路径含压缩归档重建、按引用定位消息等复杂逻辑，
   * 且已知存在并发写盘竞态；模型选择只是索引里的一个标量，单独最小写入风险最低。
   *
   * @param alias 登记簿别名；传 undefined / 空串表示「跟随全局」（从索引中清除该字段）
   */
  async setSessionModelAlias(id: string, alias: string | undefined): Promise<void> {
    const clean = (alias ?? '').trim();
    if (clean) {
      await this.updateIndex(id, { modelAlias: clean });
      return;
    }
    // 复位为跟随全局：显式删字段，避免 sessions.json 里留下空串
    const indexFile = join(this.workspaceDir, 'sessions.json');
    if (!(await fileExists(indexFile))) return;
    const sessions = JSON.parse(await readFile(indexFile, 'utf-8')) as SessionMeta[];
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx < 0) return;
    delete sessions[idx].modelAlias;
    await writeFile(indexFile, JSON.stringify(sessions, null, 2), 'utf-8');
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
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${tmpWriteSeq++}.tmp`;
    try {
      await writeFile(tmpPath, payload, 'utf-8');
      await renameWithRetry(tmpPath, filePath);
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
      this.degradedSessions.delete(id);
      return ensureMsgIds(decrypt<SessionData>(raw, key), id);
    }
    const { data, degraded } = parseSessionJson(raw, found.file);
    // 记录/清除降级标记：读干净文件即视为已恢复正常（文件已被重写或从未撕裂）
    if (degraded) this.degradedSessions.add(id);
    else this.degradedSessions.delete(id);
    return ensureMsgIds(data, id);
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
    updates: Partial<Pick<SessionMeta, 'title' | 'messageCount' | 'updatedAt' | 'modelAlias'>>,
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
