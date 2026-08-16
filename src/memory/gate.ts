// PromotionGate：晋升闸门
// 核心思想：不是什么信息都配进 L3。不同来源的信息可信度不同，晋升需要不同的确认门槛。
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Provenance, PendingFact } from './types.js';

/** 状态持久化文件名 */
const STATE_FILE = '.memory-gate.json';

/** 文件是否存在 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class PromotionGate {
  /** 不同来源的最小确认次数 */
  private static readonly REQUIRED_CONFIRMATIONS: Record<Provenance, number> = {
    owner_direct: 1, // 用户明确说的，一次就够
    owner_derived: 2, // 从用户行为推导，需两次交叉验证
    tool_output: 3, // 工具返回，需多次一致
    web_search: 4, // 网页信息，要求更高
    agent_inferred: 5, // Agent 自己推断，最难晋升
    system: -1, // 系统脚手架，永不可晋升
  };

  private pending: Map<string, PendingFact> = new Map();

  /**
   * 评估一条事实是否够格晋升
   * - 首次出现：count=1，若已达阈值（如 owner_direct 阈值=1）立即晋升
   * - 再次出现：count+1，达到阈值时返回 true
   */
  evaluate(fact: string, provenance: Provenance): boolean {
    if (provenance === 'system') return false;

    const threshold = PromotionGate.REQUIRED_CONFIRMATIONS[provenance];
    const key = this.normalize(fact);

    if (!this.pending.has(key)) {
      const entry: PendingFact = {
        fact,
        count: 1,
        provenance,
        firstSeen: new Date().toISOString(),
        category: 'fact',
        targetFile: 'MEMORY.md',
      };
      this.pending.set(key, entry);
      // 首次出现 count=1，若阈值 <= 1 则直接晋升
      return entry.count >= threshold;
    }

    const entry = this.pending.get(key)!;
    entry.count += 1;
    return entry.count >= threshold;
  }

  /** 标记事实的类别和目标文件（Dreaming 提取后调用） */
  categorize(
    fact: string,
    category: PendingFact['category'],
    targetFile: PendingFact['targetFile'],
  ): void {
    const key = this.normalize(fact);
    const entry = this.pending.get(key);
    if (entry) {
      entry.category = category;
      entry.targetFile = targetFile;
    }
  }

  /** 获取所有已确认（达到阈值）的事实并清除，晋升后调用 */
  consumeApproved(): PendingFact[] {
    const approved: PendingFact[] = [];
    for (const [key, entry] of this.pending) {
      const threshold = PromotionGate.REQUIRED_CONFIRMATIONS[entry.provenance];
      if (entry.count >= threshold) {
        approved.push(entry);
        this.pending.delete(key);
      }
    }
    return approved;
  }

  /** 查看所有待处理事实（未达到阈值的） */
  listPending(): PendingFact[] {
    return [...this.pending.values()];
  }

  /** 查看所有已确认事实（达到阈值但尚未 consume 的） */
  listApproved(): PendingFact[] {
    const approved: PendingFact[] = [];
    for (const entry of this.pending.values()) {
      const threshold = PromotionGate.REQUIRED_CONFIRMATIONS[entry.provenance];
      if (entry.count >= threshold) {
        approved.push(entry);
      }
    }
    return approved;
  }

  /** 获取某条事实的确认次数（用于诊断） */
  getCount(fact: string): number {
    return this.pending.get(this.normalize(fact))?.count ?? 0;
  }

  /** 归一化事实文本，避免同义重复 */
  private normalize(fact: string): string {
    return fact.toLowerCase().trim().replace(/[。.!！?？]+$/, '');
  }

  // ===== 状态持久化 =====

  /** 序列化 pending 状态（用于持久化，重启不丢计数） */
  serialize(): string {
    return JSON.stringify(Array.from(this.pending.entries()));
  }

  /** 反序列化恢复 pending 状态 */
  deserialize(json: string): void {
    const entries = JSON.parse(json) as [string, PendingFact][];
    this.pending = new Map(entries);
  }

  /** 保存状态到 {cwd}/.memory-gate.json */
  async saveState(workspaceDir: string): Promise<void> {
    try {
      await mkdir(workspaceDir, { recursive: true });
      const path = join(workspaceDir, STATE_FILE);
      await writeFile(path, this.serialize(), 'utf-8');
    } catch {
      // 状态保存失败不影响主流程
    }
  }

  /** 从 {cwd}/.memory-gate.json 恢复状态 */
  async loadState(workspaceDir: string): Promise<void> {
    const path = join(workspaceDir, STATE_FILE);
    if (!(await fileExists(path))) return;
    try {
      const data = await readFile(path, 'utf-8');
      this.deserialize(data);
    } catch {
      // 状态损坏时重新开始计数（对已晋升事实无影响）
    }
  }
}
