import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  mkdir,
  readFile,
  writeFile,
  access,
  readdir,
  unlink,
  rm,
} from 'node:fs/promises';
import type { ChatMessage, AgentStep } from '../types.js';
import type { SessionMeta, SessionData, WorkspaceMeta, WorkspaceSummary } from './types.js';
import { stripMemorySection } from '../memory/memory-section.js';
import { buildCompactedView, isEphemeral } from '../memory/working.js';
import { DEFAULT_WORKING_CONFIG } from '../memory/types.js';
import { encrypt, decrypt } from './crypto.js';
import { keychain } from './keychain.js';

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

/** 归档消息超过该数量时生成 lastSummary */
const MAX_ARCHIVED_BEFORE_COMPACT = 30;
/** 生成摘要时最多拼接的归档消息条数（防止超大 Session 摘要无限膨胀） */
const MAX_SUMMARY_ENTRIES = 20;
/** lastSummary 的最大字符长度（超出截断，控制恢复后首轮上下文体积） */
const MAX_SUMMARY_CHARS = 2000;

/** 将归档消息列表生成精炼摘要（限制条数与长度，避免膨胀） */
function buildSummary(messages: ChatMessage[]): string {
  // 只取最近 MAX_SUMMARY_ENTRIES 条参与拼接
  const toSummarize = messages.slice(-MAX_SUMMARY_ENTRIES);
  const parts: string[] = [];
  for (const msg of toSummarize) {
    const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    parts.push(`${roleLabel}: ${content.slice(0, 80)}`);
  }
  let summary = `[历史摘要] ${parts.join(' | ')}`;
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS) + '...';
  }
  return summary;
}

// 检查两条消息是否重复（考虑所有关键字段）
function isSameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
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

export class SessionStore {
  private workspacePath: string;
  private workspaceId: string;
  private workspaceDir: string;
  private readonly userDir: string;
  private currentSessionId: string | null = null;
  /** 保存最近 N 轮对话（每轮 = user + assistant + tool） */
  private readonly recentTurns: number;
  /** 是否启用加密存储 */
  private readonly encryptionEnabled: boolean;

  constructor(
    workspacePath: string = process.cwd(),
    recentTurns = 3,
    encryptionEnabled = true,
    userDir: string = join(homedir(), '.loop-agent'),
  ) {
    this.userDir = userDir;
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId(workspacePath);
    this.workspaceDir = join(userDir, 'sessions', this.workspaceId);
    this.recentTurns = recentTurns;
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
   * 原地重绑到新工作空间路径（切换空间）：更新空间三元组并重新初始化（建目录 + 写 meta）。
   * 需配合 process.chdir(path) 使用，使 agent / skills 等 cwd 依赖跟随新空间。
   */
  async rebindWorkspace(path: string): Promise<void> {
    this.workspacePath = path;
    this.workspaceId = workspaceId(path);
    this.workspaceDir = join(this.userDir, 'sessions', this.workspaceId);
    this.currentSessionId = null;
    await this.init();
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
   * 创建新会话（支持分层存储）
   */
  async createSession(
    firstMessage: string,
    messages: ChatMessage[],
    steps: AgentStep[],
  ): Promise<SessionMeta> {
    const id = `sess_${formatDate(new Date())}`;
    const now = new Date().toISOString();
    
    // 分层存储：首次创建时 recentMessages = messages（因为消息很少）
    const data: SessionData = {
      id,
      createdAt: now,
      updatedAt: now,
      recentMessages: messages,
      archivedCount: 0,
      recentTurns: this.recentTurns,
      // 兼容旧格式
      messages,
      steps,
    };
    
    await this.writeSession(data);
    const meta = this.toMeta(data, firstMessage);
    await this.appendIndex(meta);
    this.currentSessionId = id;
    return meta;
  }

  /**
   * 更新会话（追加新消息，自动分层存储）
   * - recentMessages 只保留最近 N 轮（N = recentTurns）
   * - 超出部分迁移到 archivedMessages
   * - 当 archivedMessages 超过阈值时，生成摘要到 lastSummary
   * @param firstUserMessage 调用方持有的本次原始用户输入（可选）。会话标题缺失时优先用它生成——
   *   messages 可能已被 L1 压缩重写（首问被摘要替换），从消息推断不可靠。
   */
  async updateSession(
    id: string,
    messages: ChatMessage[],
    steps: AgentStep[],
    firstUserMessage?: string,
  ): Promise<void> {
    const data = await this.readSession(id);

    // 保存全量消息用于兼容——合并而非覆盖：
    // 传入 messages 可能已被 L1 压缩重写（WorkingMemory.compact 只保留 system + 最近 N 轮，
    // 头部轮次被丢弃），直接覆盖会让磁盘上的全量历史也跟着丢头（首轮 user 消失、
    // system 后紧跟悬空 tool）。以已有 data.messages 为底，只去重追加新消息。
    const prevMessages = data.messages ?? [];
    const incomingSystem = messages.find((m) => m.role === 'system');
    const mergedMessages: ChatMessage[] = [];
    // system 只保留一条：优先用传入的最新 system，否则沿用旧的
    if (incomingSystem) {
      mergedMessages.push(incomingSystem);
    } else {
      const prevSystem = prevMessages.find((m) => m.role === 'system');
      if (prevSystem) mergedMessages.push(prevSystem);
    }
    for (const msg of prevMessages) {
      if (msg.role !== 'system') mergedMessages.push(msg);
    }
    for (const msg of messages) {
      // system 只保留一条；ephemeral 是恢复/压缩注入的临时占位，不写入全量历史
      if (msg.role === 'system' || isEphemeral(msg)) continue;
      const exists = mergedMessages.some((m) => isSameMessage(m, msg));
      if (!exists) mergedMessages.push(msg);
    }
    data.messages = mergedMessages;
    data.steps = steps;
    data.updatedAt = new Date().toISOString();

    // === 分层存储逻辑 ===
    const recentTurns = data.recentTurns ?? this.recentTurns;
    const turnSize = 4; // 每轮约 4 条：system + user + assistant + tool
    const maxRecentMessages = recentTurns * turnSize;

    // 当前 recentMessages（不含 system）
    let currentRecent = data.recentMessages ?? [];
    // 新的非 system 消息（同样排除临时占位，保持磁盘原材料干净）
    const nonSystemMessages = messages.filter((m) => m.role !== 'system' && !isEphemeral(m));

    // 合并当前 recent + 新消息
    let mergedRecent = [...currentRecent];
    for (const msg of nonSystemMessages) {
      // 避免重复（基于 role + content + tool_calls/tool_call_id 的完整比较）
      const exists = mergedRecent.some((m) => isSameMessage(m, msg));
      if (!exists) {
        mergedRecent.push(msg);
      }
    }

    // 如果 recentMessages 超过阈值，将最旧的迁移到 archived
    let archived = [...(data.archivedMessages ?? [])];
    if (mergedRecent.length > maxRecentMessages) {
      const overflow = mergedRecent.slice(0, mergedRecent.length - maxRecentMessages);
      mergedRecent = mergedRecent.slice(-maxRecentMessages);
      archived = [...archived, ...overflow];
    }

    // 如果 archived 超过一定数量，生成摘要
    if (archived.length > MAX_ARCHIVED_BEFORE_COMPACT) {
      const archiveSummary = buildSummary(archived);
      data.lastSummary = data.lastSummary
        ? `${data.lastSummary}\n${archiveSummary}`.slice(-MAX_SUMMARY_CHARS * 2)
        : archiveSummary;
      // 限制 lastSummary 总长度（防止跨轮次累积膨胀）
      if (data.lastSummary.length > MAX_SUMMARY_CHARS) {
        data.lastSummary = data.lastSummary.slice(-MAX_SUMMARY_CHARS);
      }
      // 保留最近 10 条 archived，其余丢弃
      archived = archived.slice(-10);
    }

    data.recentMessages = mergedRecent;
    data.archivedMessages = archived;
    data.archivedCount = archived.length + (data.archivedCount ?? 0) - (archived.length > 10 ? archived.length - 10 : 0);
    data.recentTurns = recentTurns;

    await this.writeSession(data);
    // 会话标题：WebUI「先建空会话、后发消息」时 createSession 的 title 为空——用首条用户消息补生成（已有 title 不覆盖）
    const updates: Partial<Pick<SessionMeta, 'title' | 'messageCount' | 'updatedAt'>> = {
      messageCount: mergedMessages.length,
      updatedAt: data.updatedAt,
    };
    const current = (await this.readIndex()).find((m) => m.id === id);
    if (current && !current.title) {
      // 标题来源优先级：调用方显式传入的原始输入 > 消息推断（首条 user 可能带 L2 记忆前缀，需剥离；
      // 且 L1 压缩后首问可能已被摘要替换，故推断仅作 fallback）
      const explicit = firstUserMessage?.trim();
      const firstUser = messages.find((m) => m.role === 'user');
      const text = explicit || (firstUser ? stripMemorySection(firstUser.content).trim() : '');
      if (text) updates.title = text.slice(0, 50);
    }
    await this.updateIndex(id, updates);
  }

  /**
   * 加载会话
   */
  async loadSession(id: string): Promise<SessionData> {
    const data = await this.readSession(id);
    this.currentSessionId = id;

    // 如果是旧格式（无 recentMessages），转换为分层格式
    if (!data.recentMessages && data.messages && data.messages.length > 0) {
      const nonSystemMessages = data.messages.filter((m) => m.role !== 'system');
      data.recentMessages = nonSystemMessages.slice(-this.recentTurns * 4);
      data.archivedMessages = nonSystemMessages.slice(0, Math.max(0, nonSystemMessages.length - this.recentTurns * 4));
      data.archivedCount = data.archivedMessages.length;
      data.recentTurns = this.recentTurns;

      // 如果历史过长，生成摘要
      if (data.archivedMessages.length > MAX_ARCHIVED_BEFORE_COMPACT) {
        data.lastSummary = buildSummary(data.archivedMessages);
        data.archivedMessages = data.archivedMessages.slice(-10);
      }

      // 保存转换后的数据
      await this.writeSession(data);
    }

    return data;
  }

  /**
   * 汇总所有可用消息源为完整历史（修复前旧 session 的 data.messages 可能被覆盖截断，
   * 需从 archivedMessages + recentMessages 重建；修复后新 session 的 data.messages 永远完整）。
   *
   * 两个步骤：
   *  1. 三个来源按时间顺序（archived 最早 → recent 最新）去重合并
   *  2. 从第一条 user 开始截：修复前旧 session 的 archivedMessages 可能残留孤立的
   *     assistant/tool 片段（对应的 user 已被覆盖丢掉），把它们剔掉，只保留
   *     有配对起点的连续对话
   */
  static getAllAvailableMessages(data: SessionData): ChatMessage[] {
    const seen = new Set<string>();
    const merged: ChatMessage[] = [];
    // 时间顺序：归档（最早）→ messages 直接存的 → recent（最新）
    const sources: ChatMessage[][] = [
      data.archivedMessages ?? [],
      data.messages ?? [],
      data.recentMessages ?? [],
    ];
    for (const pool of sources) {
      for (const m of pool) {
        let key: string;
        if (m.role === 'tool') key = `tool:${m.tool_call_id}`;
        else if (m.role === 'assistant') {
          const calls = (m.tool_calls ?? [])
            .map((c) => `${c.id}:${c.function.name}`)
            .join(',');
          key = `assistant:${m.content ?? ''}:${calls}`;
        } else {
          key = `${m.role}:${m.content ?? ''}`;
        }
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(m);
        }
      }
    }
    // 从第一条 user 开始截：修复前旧 session 头部可能有孤立的 assistant/tool 残留
    let firstUserIdx = merged.findIndex((m) => m.role === 'user');
    if (firstUserIdx < 0) firstUserIdx = 0; // 极端无 user 的 session，保留全部避免空
    return merged.slice(firstUserIdx);
  }

  /**
   * 获取用于恢复对话的消息
   * 与 L1 压缩共用 buildCompactedView：输出 = [system（可选）, (摘要占位 · ephemeral), 最近 N 轮]
   * 原材料用 getAllAvailableMessages（覆盖修复前被截断的旧 session）；
   * 输出不含 system（由调用方的 systemPrompt 决定）
   */
  static getRestoreMessages(
    data: SessionData,
    systemPrompt?: string,
    opts?: { keepRecentTurns?: number },
  ): ChatMessage[] {
    const full = SessionStore.getAllAvailableMessages(data).filter(
      (m) => m.role !== 'system',
    );

    return buildCompactedView(full, {
      systemPrompt,
      keepRecentTurns: opts?.keepRecentTurns ?? DEFAULT_WORKING_CONFIG.keepRecentTurns,
      summaryText: data.lastSummary || undefined,
    });
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
   * 切换当前空间不影响排列，仅「当前」标记随空间移动。
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
        current: dir === this.workspaceId,
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
    const dir = await this.resolveWorkspaceDir(id);
    const dataFile = join(dir, `${id}${this.sessionFileExt}`);
    const encFile = join(dir, `${id}.enc`);
    const jsonFile = join(dir, `${id}.json`);
    for (const f of [dataFile, encFile, jsonFile]) {
      if (await fileExists(f)) {
        await unlink(f);
      }
    }
    await this.removeFromIndex(id, dir);
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

  private async writeSession(data: SessionData): Promise<void> {
    const dir = await this.resolveWorkspaceDir(data.id);
    const filePath = join(dir, `${data.id}${this.sessionFileExt}`);
    if (this.encryptionEnabled) {
      const key = keychain.getKey();
      if (!key) {
        throw new Error('密钥未加载，无法保存会话');
      }
      const encrypted = encrypt(data, key);
      await writeFile(filePath, encrypted, 'utf-8');
    } else {
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
  }

  private async readSession(id: string): Promise<SessionData> {
    const dir = await this.resolveWorkspaceDir(id);
    const filePath = join(dir, `${id}${this.sessionFileExt}`);
    if (this.encryptionEnabled) {
      const key = keychain.getKey();
      if (!key) {
        throw new Error('密钥未加载，无法读取会话');
      }
      const encrypted = await readFile(filePath, 'utf-8');
      return decrypt<SessionData>(encrypted, key);
    } else {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as SessionData;
    }
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
    // 优先使用 recentMessages 数量 + archivedCount，兼容旧格式
    const count = data.recentMessages
      ? data.recentMessages.length + (data.archivedCount ?? 0)
      : (data.messages?.length ?? 0);
    return {
      id: data.id,
      title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: count,
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
