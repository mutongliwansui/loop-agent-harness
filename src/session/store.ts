import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
import type { SessionMeta, SessionData, WorkspaceMeta } from './types.js';
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
  private workspaceId: string;
  private workspaceDir: string;
  private currentSessionId: string | null = null;
  /** 保存最近 N 轮对话（每轮 = user + assistant + tool） */
  private readonly recentTurns: number;

  constructor(workspacePath: string = process.cwd(), recentTurns = 3) {
    this.workspaceId = workspaceId(workspacePath);
    this.workspaceDir = join(homedir(), '.loop-agent', 'sessions', this.workspaceId);
    this.recentTurns = recentTurns;
  }

  /** 当前会话 ID */
  get currentId(): string | null {
    return this.currentSessionId;
  }

  /** 当前工作空间 ID */
  get id(): string {
    return this.workspaceId;
  }

  /**
   * 初始化：确保密钥已加载，创建目录
   */
  async init(): Promise<void> {
    keychain.ensureUnlocked();
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
   */
  async updateSession(
    id: string,
    messages: ChatMessage[],
    steps: AgentStep[],
  ): Promise<void> {
    const data = await this.readSession(id);

    // 保存原始全量消息用于兼容
    data.messages = messages;
    data.steps = steps;
    data.updatedAt = new Date().toISOString();

    // === 分层存储逻辑 ===
    const recentTurns = data.recentTurns ?? this.recentTurns;
    const turnSize = 4; // 每轮约 4 条：system + user + assistant + tool
    const maxRecentMessages = recentTurns * turnSize;

    // 当前 recentMessages（不含 system）
    let currentRecent = data.recentMessages ?? [];
    // 新的非 system 消息
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

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
    await this.updateIndex(id, {
      messageCount: messages.length,
      updatedAt: data.updatedAt,
    });
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
   * 获取用于恢复对话的消息（仅 recentMessages + system 提示）
   * 不含 archivedMessages，控制上下文大小
   */
  static getRestoreMessages(data: SessionData, systemPrompt?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // 1. 添加 system 提示（可选）
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 2. 添加 lastSummary 作为历史上下文
    if (data.lastSummary) {
      messages.push({
        role: 'user',
        content: `[会话历史摘要] ${data.lastSummary}`,
      });
    }

    // 3. 添加 recentMessages（恢复最近对话）
    if (data.recentMessages && data.recentMessages.length > 0) {
      messages.push(...data.recentMessages);
    } else if (data.messages) {
      // 兼容旧格式
      messages.push(...data.messages);
    }

    return messages;
  }

  /**
   * 列出当前工作空间的所有会话
   */
  async listSessions(): Promise<SessionMeta[]> {
    return this.readIndex();
  }

  /**
   * 删除会话
   */
  async deleteSession(id: string): Promise<void> {
    const encFile = join(this.workspaceDir, `${id}.enc`);
    if (await fileExists(encFile)) {
      await unlink(encFile);
    }
    await this.removeFromIndex(id);
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

  private async writeSession(data: SessionData): Promise<void> {
    const key = keychain.getKey();
    if (!key) {
      throw new Error('密钥未加载，无法保存会话');
    }
    const encrypted = encrypt(data, key);
    await writeFile(join(this.workspaceDir, `${data.id}.enc`), encrypted, 'utf-8');
  }

  private async readSession(id: string): Promise<SessionData> {
    const key = keychain.getKey();
    if (!key) {
      throw new Error('密钥未加载，无法读取会话');
    }
    const encrypted = await readFile(join(this.workspaceDir, `${id}.enc`), 'utf-8');
    return decrypt<SessionData>(encrypted, key);
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
    updates: Partial<Pick<SessionMeta, 'messageCount' | 'updatedAt'>>,
  ): Promise<void> {
    const sessions = await this.readIndex();
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], ...updates };
      await this.writeIndex(sessions);
    }
  }

  private async removeFromIndex(id: string): Promise<void> {
    const sessions = await this.readIndex();
    const filtered = sessions.filter((s) => s.id !== id);
    await this.writeIndex(filtered);
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
      file: `${data.id}.enc`,
    };
  }

  private async touchWorkspaceMeta(): Promise<void> {
    const metaFile = join(this.workspaceDir, 'meta.json');
    let meta: WorkspaceMeta;
    if (await fileExists(metaFile)) {
      const content = await readFile(metaFile, 'utf-8');
      meta = JSON.parse(content) as WorkspaceMeta;
      meta.lastAccessedAt = new Date().toISOString();
    } else {
      meta = {
        workspacePath: process.cwd(),
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      };
    }
    await writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
  }
}
