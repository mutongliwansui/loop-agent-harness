// ToolMemoryCallback：工具结果自动写入 L2（带来源标记 + Session 隔离）
// 工具产生的结果是重要记忆来源，但不直接晋升到 L3
// 会话身份由调用方每次传入（不再持有可变实例状态，避免多会话并发串号）
import { EpisodicMemory } from './episodic.js';

export class ToolMemoryCallback {
  private episodic: EpisodicMemory;

  constructor(episodic: EpisodicMemory) {
    this.episodic = episodic;
  }

  /** 工具调用结果自动写入 L2（session 级；无 sessionId 时由 append 侧拒绝写入） */
  async log(
    toolName: string,
    input: Record<string, unknown>,
    output: string,
    sessionId?: string,
  ): Promise<void> {
    const truncated = this.truncate(output, 200);
    const entry = `- [tool:${toolName}] input=${JSON.stringify(input)} → ${truncated}`;
    try {
      await this.episodic.appendToday(entry, {
        sessionId,
        scope: 'session',
        tag: 'tool',
      });
    } catch {
      // 写入失败静默丢弃，不阻塞主流程
    }
  }

  /** 工具错误也记录 */
  async logError(toolName: string, error: string, sessionId?: string): Promise<void> {
    const entry = `- [tool:${toolName}] ERROR: ${this.truncate(error, 200)}`;
    try {
      await this.episodic.appendToday(entry, {
        sessionId,
        scope: 'session',
        tag: 'error',
      });
    } catch {
      // 静默丢弃
    }
  }

  /**
   * 记录全局级别的记忆（跨会话可见）
   * 用于重要的系统信息或用户偏好；sessionId 仅作来源追溯，可缺省
   */
  async logGlobal(content: string, tag?: string, sessionId?: string): Promise<void> {
    try {
      await this.episodic.appendToday(content, {
        sessionId,
        scope: 'global',
        tag,
      });
    } catch {
      // 静默丢弃
    }
  }

  private truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max) + '...';
  }
}
