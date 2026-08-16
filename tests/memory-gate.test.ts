/**
 * Phase 3 验收测试：PromotionGate（晋升闸门）
 *
 * 覆盖验收项：
 * - 3.1 Gate 状态持久化：重启后 pending 计数不丢失
 * - 3.2 低可信度不晋升：owner_derived 需 2 次确认才晋升
 * - 3.3 高可信度快速晋升：owner_direct 1 次即晋升
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PromotionGate } from '../src/memory/gate.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const WORKSPACE_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-gate');

describe('PromotionGate', () => {
  beforeAll(async () => {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true });
    mkdirSync(WORKSPACE_DIR, { recursive: true });
  });

  afterAll(async () => {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  });

  it('3.3 高可信度快速晋升：owner_direct 首次出现即晋升', () => {
    const gate = new PromotionGate();
    // owner_direct 阈值=1，首次出现 count=1 即晋升
    expect(gate.evaluate('用户是采购负责人', 'owner_direct')).toBe(true);
  });

  it('3.2 低可信度不晋升：owner_derived 需 2 次确认', () => {
    const gate = new PromotionGate();
    // 第一次：false
    expect(gate.evaluate('用户偏好性价比优先', 'owner_derived')).toBe(false);
    // 第二次：count=2 >= 2 → true
    expect(gate.evaluate('用户偏好性价比优先', 'owner_derived')).toBe(true);
  });

  it('3.2b agent_inferred 需 5 次确认', () => {
    const gate = new PromotionGate();
    const fact = 'Agent 推断的结论';
    for (let i = 1; i <= 4; i++) {
      expect(gate.evaluate(fact, 'agent_inferred')).toBe(false);
    }
    // 第 5 次：达到阈值
    expect(gate.evaluate(fact, 'agent_inferred')).toBe(true);
  });

  it('3.2c system 来源永不可晋升', () => {
    const gate = new PromotionGate();
    expect(gate.evaluate('系统脚手架信息', 'system')).toBe(false);
    expect(gate.evaluate('系统脚手架信息', 'system')).toBe(false);
    expect(gate.listApproved().length).toBe(0);
  });

  it('3.2d 事实归一化：标点/大小写不影响去重', () => {
    const gate = new PromotionGate();
    // owner_derived 阈值=2：首次出现 count=1 → false
    expect(gate.evaluate('用户是采购负责人。', 'owner_derived')).toBe(false);
    // 去标点后视为同一条事实，count=2 → 晋升
    expect(gate.evaluate('用户是采购负责人', 'owner_derived')).toBe(true);
  });

  it('3.1 Gate 状态持久化：保存后新实例可恢复计数', async () => {
    const gate = new PromotionGate();
    // 累积 1 次 owner_derived（未达阈值）
    gate.evaluate('项目使用 TypeScript', 'owner_derived');
    expect(gate.getCount('项目使用 TypeScript')).toBe(1);

    // 保存状态
    await gate.saveState(WORKSPACE_DIR);

    // 模拟重启：新实例加载状态
    const restored = new PromotionGate();
    await restored.loadState(WORKSPACE_DIR);

    // 计数不丢失：再次出现即达阈值晋升
    expect(restored.getCount('项目使用 TypeScript')).toBe(1);
    expect(restored.evaluate('项目使用 TypeScript', 'owner_derived')).toBe(true);
  });

  it('3.1b consumeApproved 晋升后清除 pending', () => {
    const gate = new PromotionGate();
    // owner_direct 首次出现即达阈值
    gate.evaluate('事实A', 'owner_direct');

    const approved = gate.consumeApproved();
    expect(approved.length).toBe(1);
    expect(approved[0].fact).toBe('事实A');
    // 清除后 pending 为空
    expect(gate.listPending().length).toBe(0);
  });

  it('categorize 标记目标文件与类别', () => {
    const gate = new PromotionGate();
    gate.evaluate('用户偏好红色主题', 'owner_direct');
    gate.categorize('用户偏好红色主题', 'preference', 'USER.md');

    const approved = gate.listApproved();
    expect(approved.length).toBe(1);
    expect(approved[0].category).toBe('preference');
    expect(approved[0].targetFile).toBe('USER.md');
  });
});
