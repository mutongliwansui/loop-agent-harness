import type { ChatMessage } from '../types.js';

/** 会话元信息（存储在索引中，不含消息内容） */
export interface SessionMeta {
  /** 会话 ID */
  id: string;
  /** 会话标题（首条用户消息前 50 字符） */
  title: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 更新时间 ISO */
  updatedAt: string;
  /** 消息数量 */
  messageCount: number;
  /** 加密文件名 */
  file: string;
}

/**
 * 完整会话数据（加密存储的内容）。
 *
 * 单一真源：`messages` 按时间正序保存全量历史（含 system）。每条消息通过
 * `is_compact`（是否已被压缩折叠进摘要）、`is_show`（是否在界面展示）、
 * `show_content`（展示内容，content 含注入前缀时使用）、`kind`（'summary' 表示
 * 压缩总结消息）四个标记表达状态，不再使用 recentMessages/archivedMessages/fullHistory/lastSummary 等分层字段。
 */
export interface SessionData {
  id: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 更新时间 ISO */
  updatedAt: string;
  /** 全量历史（含 system），每条带 is_compact/is_show/show_content/kind 标记 */
  messages: ChatMessage[];
}

/** 工作空间元信息 */
export interface WorkspaceMeta {
  workspacePath: string;
  /** 工作空间名称（工作目录的目录名） */
  workspaceName: string;
  createdAt: string;
  lastAccessedAt: string;
}

/** 跨工作空间聚合的工作空间概要（GET /workspaces） */
export interface WorkspaceSummary {
  /** 工作空间目录 ID（SHA-256 前 16 位） */
  id: string;
  /** 工作空间名称（meta.json 的 workspaceName；旧文件缺失时回退为路径目录名） */
  name: string;
  /** 工作目录绝对路径 */
  path: string;
  /** 是否为当前服务进程的工作空间 */
  current: boolean;
  createdAt: string;
  lastAccessedAt: string;
  /** 该空间下的会话索引（按 updatedAt 降序） */
  sessions: SessionMeta[];
}

/** 会话存储配置 */
export interface SessionConfig {
  autoSave: boolean;
  autoRestore: boolean;
  encryptionEnabled: boolean;
}

/** 默认会话配置 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  autoSave: true,
  autoRestore: true,
  encryptionEnabled: true,
};
