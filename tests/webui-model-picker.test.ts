// model-picker 单测（task-20261025-002 P1）
// 面板行构建与 pill 状态解析均为纯函数
import { describe, expect, it } from 'vitest';
import {
  buildPickerRows,
  hostOf,
  resolvePill,
  type ModelProfileRow,
} from '../webui/src/model-picker.js';

const PROFILES: ModelProfileRow[] = [
  { alias: 'deepseek', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', isCurrent: true },
  { alias: 'glm', name: 'glm-4-plus', baseUrl: 'https://tokenhub.haizhi.com/v1' },
  { alias: 'local', name: 'qwen2.5', baseUrl: 'http://127.0.0.1:11434/v1' },
];

describe('hostOf：从 baseUrl 提取主机名', () => {
  it('标准 URL 取 host', () => {
    expect(hostOf('https://tokenhub.haizhi.com/v1')).toBe('tokenhub.haizhi.com');
    expect(hostOf('http://127.0.0.1:11434/v1')).toBe('127.0.0.1:11434');
  });

  it('非法 URL 剥离协议与路径后原样返回，不抛错', () => {
    expect(hostOf('not a url')).toBe('not a url');
    expect(hostOf('')).toBe('');
  });
});

describe('buildPickerRows：面板行', () => {
  it('按 alias 升序，全局项唯一且带标记', () => {
    const rows = buildPickerRows(PROFILES, 'deepseek', '');
    expect(rows.map((r) => r.alias)).toEqual(['deepseek', 'glm', 'local']);
    expect(rows.filter((r) => r.isGlobal)).toHaveLength(1);
    expect(rows.find((r) => r.isGlobal)?.alias).toBe('deepseek');
  });

  it('host 从 baseUrl 提取，用于区分同名模型的不同供应商', () => {
    const rows = buildPickerRows(PROFILES, 'deepseek', '');
    expect(rows.find((r) => r.alias === 'glm')?.host).toBe('tokenhub.haizhi.com');
  });

  it('未选（空串）时没有任何行标记为已选', () => {
    const rows = buildPickerRows(PROFILES, 'deepseek', '');
    expect(rows.every((r) => !r.isSelected)).toBe(true);
  });

  it('选中非全局项时只有该项 isSelected', () => {
    const rows = buildPickerRows(PROFILES, 'deepseek', 'glm');
    const selected = rows.filter((r) => r.isSelected);
    expect(selected).toHaveLength(1);
    expect(selected[0].alias).toBe('glm');
  });

  it('activeAlias 为 null 时（无全局激活）无全局徽标，回退服务端 isCurrent', () => {
    const rows = buildPickerRows(PROFILES, null, '');
    expect(rows.every((r) => !r.isGlobal)).toBe(true);
    expect(rows.find((r) => r.isCurrent)?.alias).toBe('deepseek');
  });

  it('不修改入参数组（纯函数）', () => {
    const input = [...PROFILES];
    buildPickerRows(input, 'deepseek', 'glm');
    expect(input.map((p) => p.alias)).toEqual(['deepseek', 'glm', 'local']);
  });
});

describe('resolvePill：pill 展示状态', () => {
  it('未选 → 跟随全局，label 为全局 alias，无 pinned 与复位入口', () => {
    expect(resolvePill('', 'deepseek')).toEqual({
      label: 'deepseek',
      pinned: false,
      showFollowGlobal: false,
    });
    expect(resolvePill(undefined, 'deepseek').pinned).toBe(false);
  });

  it('选中全局项本身 → 不算覆盖（避免假的覆盖态）', () => {
    const st = resolvePill('deepseek', 'deepseek');
    expect(st.pinned).toBe(false);
    expect(st.showFollowGlobal).toBe(false);
  });

  it('选中其它项 → pinned + 露出「跟随全局」', () => {
    expect(resolvePill('glm', 'deepseek')).toEqual({
      label: 'glm',
      pinned: true,
      showFollowGlobal: true,
    });
  });

  it('无全局 alias 且未选时 label 降级为「模型」', () => {
    expect(resolvePill('', null).label).toBe('模型');
    expect(resolvePill('', '').label).toBe('模型');
  });
});
