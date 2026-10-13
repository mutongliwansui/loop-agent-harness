/**
 * 多模型 schema 默认值与跨层 deepMerge 叠加单测（Task-20261011-002 P0）
 * 覆盖：DEFAULT_CONFIG.models 兼容锚点、profiles Record 跨层叠加（对比数组整体替换）、
 *       激活即同步快照的合并语义、deepMerge 跳过 undefined（temperature 保留现值）
 */
import { describe, it, expect } from 'vitest';
import { deepMerge } from '../src/config/merge.js';
import { DEFAULT_CONFIG, type AgentConfig, type PartialAgentConfig } from '../src/config/schema.js';

describe('schema 默认值', () => {
  it('DEFAULT_CONFIG.models：active 空串 + 空 profiles（存量单模型用户兼容锚点）', () => {
    expect(DEFAULT_CONFIG.models).toEqual({ active: '', profiles: {} });
    expect(DEFAULT_CONFIG.models.active).toBe('');
    expect(Object.keys(DEFAULT_CONFIG.models.profiles)).toHaveLength(0);
  });

  it('deepMerge 后 models 默认值不被清除', () => {
    const merged = deepMerge<AgentConfig>(DEFAULT_CONFIG, {});
    expect(merged.models).toEqual({ active: '', profiles: {} });
  });
});

describe('跨层 deepMerge 叠加', () => {
  it('profiles 用 Record：global 与 workspace 登记簿跨层叠加', () => {
    const globalLayer: PartialAgentConfig = {
      models: { profiles: { glm: { name: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-g' } } },
    };
    const workspaceLayer: PartialAgentConfig = {
      models: { profiles: { ds: { name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-w' } } },
    };
    const merged = deepMerge<AgentConfig>(DEFAULT_CONFIG, globalLayer, workspaceLayer);
    expect(Object.keys(merged.models.profiles).sort()).toEqual(['ds', 'glm']);
  });

  it('同名别名跨层：workspace 覆盖 global 对应字段（叶子替换）', () => {
    const globalLayer: PartialAgentConfig = {
      models: { profiles: { ds: { name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-global' } } },
    };
    const workspaceLayer: PartialAgentConfig = {
      models: { profiles: { ds: { name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-workspace' } } },
    };
    const merged = deepMerge<AgentConfig>(DEFAULT_CONFIG, globalLayer, workspaceLayer);
    expect(merged.models.profiles.ds.apiKey).toBe('sk-workspace');
  });

  it('对比：数组形态会被整体替换（这正是 profiles 不用数组的原因）', () => {
    const merged = deepMerge<{ list: Array<{ id: string }> }>(
      { list: [{ id: 'a' }] },
      { list: [{ id: 'b' }] },
    );
    expect(merged.list).toEqual([{ id: 'b' }]);
  });

  it('workspace 层 model.* 覆盖 global 层（叶子级替换）', () => {
    const globalLayer: PartialAgentConfig = { model: { name: 'global-model', apiKey: 'sk-global' } };
    const workspaceLayer: PartialAgentConfig = { model: { apiKey: 'sk-workspace' } };
    const merged = deepMerge<AgentConfig>(DEFAULT_CONFIG, globalLayer, workspaceLayer);
    expect(merged.model.name).toBe('global-model');
    expect(merged.model.apiKey).toBe('sk-workspace');
  });
});

describe('激活即同步快照（/model use 写入的合并语义）', () => {
  it('use partial 合并后：models.active 指向新别名且 model.* 快照同步', () => {
    const base = deepMerge<AgentConfig>(DEFAULT_CONFIG, {
      model: { name: 'old-model', baseUrl: 'https://old.example.com/v1', apiKey: 'sk-old', temperature: 0.5 },
      models: { active: 'old', profiles: { old: { name: 'old-model', baseUrl: 'https://old.example.com/v1', apiKey: 'sk-old' } } },
    });

    const usePartial: PartialAgentConfig = {
      models: { active: 'glm' },
      model: { name: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-glm' },
    };
    const merged = deepMerge<AgentConfig>(base, usePartial);

    expect(merged.models.active).toBe('glm');
    expect(merged.model.name).toBe('glm-4.6');
    expect(merged.model.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(merged.model.apiKey).toBe('sk-glm');
    // 旧登记簿保留（切换不动各模型已有配置）
    expect(merged.models.profiles.old).toBeDefined();
    // temperature 未携带 → deepMerge 跳过 undefined 语义下不覆盖现值
    expect(merged.model.temperature).toBe(0.5);
  });

  it('profile 携带 temperature 时覆盖现值', () => {
    const base = deepMerge<AgentConfig>(DEFAULT_CONFIG, { model: { temperature: 0.5 } });
    const usePartial: PartialAgentConfig = {
      models: { active: 'glm' },
      model: { name: 'glm-4.6', baseUrl: 'https://x/v4', apiKey: 'sk', temperature: 0.3 },
    };
    const merged = deepMerge<AgentConfig>(base, usePartial);
    expect(merged.model.temperature).toBe(0.3);
  });

  it('deepMerge 直接语义：source 值为 undefined 时跳过保留前值', () => {
    const merged = deepMerge<{ a: number; b: { c: number } }>(
      { a: 1, b: { c: 2 } },
      { a: undefined, b: { c: undefined } } as unknown as { a: number; b: { c: number } },
    );
    expect(merged).toEqual({ a: 1, b: { c: 2 } });
  });
});
