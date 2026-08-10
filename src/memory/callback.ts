// ToolMemoryCallback：工具结果自动写入 L2（带来源标记 + Session 隔离）
// 工具产生的结果是重要记忆来源，但不直接晋升到 L3
import { EpisodicMemory, type AppendOptions, type MemoryScope } from './episodic.js';

export class ToolMemoryCallback {
  private episodic: EpisodicMemory;
  private _sessionId: string | null = null;

  constructor(episodic: EpisodicMemory) {
    this.episodic = episodic;
  }

  /** 设置当前会话 ID（由 ReActAgent 在运行时调用） */
  setSessionId(sessionId: string | null): void {
    this._sessionId = sessionId;
  }

  /** 工具调用结果自动写入 L2 */
  async log(toolName: string, input: Record<string, unknown>, output: string): Promise<void> {
    const truncated = this.truncate(output, 200);
    const entry = `- [tool:${toolName}] input=${JSON.stringify(input)} → ${truncated}`;
    try {
      const options: AppendOptions = {
        tag: 'tool',
      };
      // 工具结果默认为 session 作用域（仅当前会话可见）
      if (this._sessionId) {
        options.sessionId = this._sessionId;
        options.scope = 'session';
      }
      await this.episodic.appendToday(entry, options);
    } catch {
      // 写入失败静默丢弃，不阻塞主流程
    }
  }

  /** 工具错误也记录 */
  async logError(toolName: string, error: string): Promise<void> {
    const entry = `- [tool:${toolName}] ERROR: ${this.truncate(error, 200)}`;
    try {
      const options: AppendOptions = {
        tag: 'error',
      };
      if (this._sessionId) {
        options.sessionId = this._sessionId;
        options.scope = 'session';
      }
      await this.episodic.appendToday(entry, options);
    } catch {
      // 静默丢弃
    }
  }

  /**
   * 记录全局级别的记忆（跨会话可见）
   * 用于重要的系统信息或用户偏好
   */
  async logGlobal(content: string, tag?: string): Promise<void> {
    try {
      const options: AppendOptions = {
        scope: 'global',
        tag,
      };
      if (this._sessionId) {
        options.sessionId = this._sessionId;
      }
      await this.episodic.appendToday(content, options);
    } catch {
      // 静默丢弃
    }
  }

  private truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max) + '...';
  }
}
