/**
 * /model 多模型接入与切换单测（Task-20261011-002 P0+P1）
 * 覆盖：use 写入内容（active+快照、temperature 缺省跳过）、未知别名/空 key 拦截、
 *       --global 跨层冲突警示与 P1 交互清理、add 交互登记/重名中止/可选连通性/补录、
 *       remove 激活保护/跨层归属提示、list 兼容态与漂移警示、test 三态、
 *       纯函数（maskKey/detectDrift/collectConflictKeys）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../src/commands/registry.js';
import type { AgentConfig, ModelConfig, ModelProfile } from '../src/config/schema.js';

const { loadMock, loadWorkspaceMock, loadGlobalMock, updateScopeMock, deleteScopeKeyMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  loadWorkspaceMock: vi.fn(),
  loadGlobalMock: vi.fn(),
  updateScopeMock: vi.fn(),
  deleteScopeKeyMock: vi.fn(),
}));

vi.mock('../src/config/index.js', () => ({
  configLoader: {
    load: loadMock,
    loadWorkspace: loadWorkspaceMock,
    loadGlobal: loadGlobalMock,
  },
}));

// 切断 wizard 的传递依赖（真实 createMaskedAsk 依赖 readline；测试中交互均走 deps 注入）
vi.mock('../src/bootstrap/wizard.js', () => ({
  createMaskedAsk: () => async () => '',
}));

import {
  buildUsePartial,
  collectConflictKeys,
  createModelCommand,
  detectDrift,
  maskKey,
} from '../src/commands/model-command.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function logsOf(lines: string[]): string {
  return lines.join('\n').replace(ANSI_RE, '');
}

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-main-9999',
    temperature: 0.5,
    maxIterations: 10,
    ...overrides,
  };
}

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { name: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-glm-abcd', ...overrides };
}

function cfg(opts: { active?: string; profiles?: Record<string, ModelProfile>; model?: ModelConfig } = {}): AgentConfig {
  return {
    model: opts.model ?? model(),
    models: { active: opts.active ?? '', profiles: opts.profiles ?? {} },
  } as unknown as AgentConfig;
}

function makeCtx(cfgValue: AgentConfig, layerRaw: { workspace?: unknown; global?: unknown } = {}): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    configLoader: {
      load: loadMock.mockReturnValue({ config: cfgValue, sources: {} }),
      loadWorkspace: loadWorkspaceMock.mockResolvedValue(layerRaw.workspace ?? null),
      loadGlobal: loadGlobalMock.mockResolvedValue(layerRaw.global ?? null),
    },
    configWriter: { updateScope: updateScopeMock, deleteScopeKey: deleteScopeKeyMock },
    rl: {},
    out: {
      log: (s: string) => lines.push(s),
      blank: () => lines.push(''),
      error: (s: string) => lines.push(s),
    },
  } as unknown as CommandContext;
  return { ctx, lines };
}

function scriptedAsk(answers: string[]) {
  let i = 0;
  const ask = async () => answers[i++] ?? '';
  return { ask, askSecret: ask };
}

beforeEach(() => {
  loadMock.mockReset();
  loadWorkspaceMock.mockReset();
  loadGlobalMock.mockReset();
  updateScopeMock.mockReset();
  updateScopeMock.mockResolvedValue(undefined);
  deleteScopeKeyMock.mockReset();
  deleteScopeKeyMock.mockResolvedValue(undefined);
});

describe('纯函数', () => {
  it('maskKey：长 key 留尾 4 位，短 key 全遮蔽', () => {
    expect(maskKey('sk-abcdefabcd')).toBe('****abcd');
    expect(maskKey('abc')).toBe('****');
  });

  it('buildUsePartial：active + 快照三元组；temperature 未定义时不携带该键', () => {
    const noTemp = buildUsePartial('glm', profile());
    expect(noTemp).toEqual({
      models: { active: 'glm' },
      model: { name: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-glm-abcd' },
    });
    expect('temperature' in (noTemp.model as Record<string, unknown>)).toBe(false);

    const withTemp = buildUsePartial('glm', profile({ temperature: 0.3 }));
    expect((withTemp.model as Record<string, unknown>).temperature).toBe(0.3);
  });

  it('detectDrift：未激活为 null；一致为 null；name/baseUrl 不一致或登记缺失时警示', () => {
    expect(detectDrift(cfg())).toBeNull();
    // 一致态：profile 的 name/baseUrl 与生效快照相同（apiKey 轮换不算漂移）
    const m = model();
    expect(detectDrift(cfg({ active: 'glm', profiles: { glm: profile({ name: m.name, baseUrl: m.baseUrl }) } }))).toBeNull();

    const drifted = cfg({ active: 'glm', profiles: { glm: profile() }, model: model({ name: 'changed-model' }) });
    expect(detectDrift(drifted)).toContain('不一致');
    expect(detectDrift(drifted)).toContain('/model use glm');

    expect(detectDrift(cfg({ active: 'ghost', profiles: {} }))).toContain('不存在');
  });

  it('collectConflictKeys：收集 model.* 与 models.active；null 无冲突', () => {
    expect(collectConflictKeys(null)).toEqual([]);
    expect(collectConflictKeys({})).toEqual([]);
    expect(collectConflictKeys({ model: { name: 'x', apiKey: 'k' }, models: { active: 'glm' } })).toEqual([
      'model.name',
      'model.apiKey',
      'models.active',
    ]);
  });
});

describe('/model use', () => {
  it('默认写工作空间：updateScope 收到 active+快照', async () => {
    const { ctx } = makeCtx(cfg({ active: 'glm', profiles: { glm: profile() } }));
    const cmd = createModelCommand();
    await cmd.execute('/model use glm', ctx);

    expect(updateScopeMock).toHaveBeenCalledTimes(1);
    const [scope, partial] = updateScopeMock.mock.calls[0];
    expect(scope).toBe('workspace');
    expect(partial.models.active).toBe('glm');
    expect(partial.model.name).toBe('glm-4.6');
    expect(partial.model.apiKey).toBe('sk-glm-abcd');
  });

  it('未知别名：报错并列候选，不写盘', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile() } }));
    const cmd = createModelCommand();
    await cmd.execute('/model use nope', ctx);

    expect(updateScopeMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('未找到模型「nope」');
    expect(logsOf(lines)).toContain('glm');
  });

  it('profile 无 apiKey：拦截不写盘并给出补救提示', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile({ apiKey: '' }) } }));
    const cmd = createModelCommand();
    await cmd.execute('/model use glm', ctx);

    expect(updateScopeMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('未配置 apiKey');
    expect(logsOf(lines)).toContain('models.profiles.glm.apiKey');
  });

  it('--global 且 workspace 层有 model.*/models.active 冲突：警示后默认不清理仍写全局', async () => {
    const { ctx, lines } = makeCtx(
      cfg({ profiles: { glm: profile() } }),
      { workspace: { model: { name: 'x', apiKey: 'k' }, models: { active: 'x' } } },
    );
    // P1 新增清理询问：空应答 = 默认否，维持 P0 警示行为
    const cmd = createModelCommand(scriptedAsk(['']));
    await cmd.execute('/model use glm --global', ctx);

    expect(logsOf(lines)).toContain('优先级高于全局');
    expect(logsOf(lines)).toContain('model.name');
    expect(logsOf(lines)).toContain('models.active');
    expect(deleteScopeKeyMock).not.toHaveBeenCalled();
    const [scope, partial] = updateScopeMock.mock.calls[0];
    expect(scope).toBe('global');
    expect(partial.models.active).toBe('glm');
  });

  it('--global 冲突清理（确认 y）：逐键 deleteScopeKey 后写全局', async () => {
    const { ctx, lines } = makeCtx(
      cfg({ profiles: { glm: profile() } }),
      { workspace: { model: { name: 'x', apiKey: 'k' }, models: { active: 'x' } } },
    );
    const cmd = createModelCommand(scriptedAsk(['y']));
    await cmd.execute('/model use glm --global', ctx);

    expect(deleteScopeKeyMock).toHaveBeenCalledTimes(3);
    expect(deleteScopeKeyMock).toHaveBeenNthCalledWith(1, 'workspace', ['model', 'name']);
    expect(deleteScopeKeyMock).toHaveBeenNthCalledWith(2, 'workspace', ['model', 'apiKey']);
    expect(deleteScopeKeyMock).toHaveBeenNthCalledWith(3, 'workspace', ['models', 'active']);
    expect(logsOf(lines)).toContain('已清理工作空间冲突键');
    const [scope, partial] = updateScopeMock.mock.calls[0];
    expect(scope).toBe('global');
    expect(partial.models.active).toBe('glm');
  });

  it('--global 冲突清理（拒绝）：不清理仍写全局并给出替代建议', async () => {
    const { ctx, lines } = makeCtx(
      cfg({ profiles: { glm: profile() } }),
      { workspace: { model: { name: 'x', apiKey: 'k' }, models: { active: 'x' } } },
    );
    const cmd = createModelCommand(scriptedAsk(['n']));
    await cmd.execute('/model use glm --global', ctx);

    expect(deleteScopeKeyMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('可改用');
    const [scope] = updateScopeMock.mock.calls[0];
    expect(scope).toBe('global');
  });
});

describe('/model add', () => {
  it('交互登记（位置默认回车=工作空间）：写入 profiles.<别名>，key 落盘为明文、展示为遮蔽', async () => {
    const { ctx, lines } = makeCtx(cfg());
    // 依次：写入位置（回车默认）、baseUrl、apiKey、name
    const cmd = createModelCommand(scriptedAsk(['', 'https://api.x.com/v1', 'sk-new-7777', 'x-model']));
    await cmd.execute('/model add x1', ctx);

    const [scope, partial] = updateScopeMock.mock.calls[0];
    expect(scope).toBe('workspace');
    expect(partial.models.profiles.x1).toEqual({
      name: 'x-model',
      baseUrl: 'https://api.x.com/v1',
      apiKey: 'sk-new-7777',
    });
    expect(logsOf(lines)).toContain('****7777');
    expect(logsOf(lines)).not.toContain('sk-new-7777');
  });

  it('写入位置选 2：写入全局', async () => {
    const { ctx } = makeCtx(cfg());
    // 依次：写入位置 2（全局）、baseUrl、apiKey、name
    const cmd = createModelCommand(scriptedAsk(['2', 'u', 'k', 'x-model']));
    await cmd.execute('/model add x1', ctx);

    const [scope, partial] = updateScopeMock.mock.calls[0];
    expect(scope).toBe('global');
    expect(partial.models.profiles.x1).toEqual({ name: 'x-model', baseUrl: 'u', apiKey: 'k' });
  });

  it('显式 --global：跳过位置询问，输入序列不错位', async () => {
    const { ctx } = makeCtx(cfg());
    // 依次：baseUrl、apiKey、name（无位置答案——flag 已显式指定）
    const cmd = createModelCommand(scriptedAsk(['u', 'k', 'x-model']));
    await cmd.execute('/model add x1 --global', ctx);

    const [scope, partial] = updateScopeMock.mock.calls[0];
    expect(scope).toBe('global');
    expect(partial.models.profiles.x1).toEqual({ name: 'x-model', baseUrl: 'u', apiKey: 'k' });
  });

  it('重名中止：不写盘', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { x1: profile() } }));
    const cmd = createModelCommand(scriptedAsk(['u', 'k', 'n']));
    await cmd.execute('/model add x1', ctx);

    expect(updateScopeMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('已存在');
  });

  it('非法别名（- 开头）：提示用法不写盘', async () => {
    const { ctx, lines } = makeCtx(cfg());
    const cmd = createModelCommand(scriptedAsk([]));
    await cmd.execute('/model add --global', ctx);

    expect(updateScopeMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('用法');
  });

  it('可选连通性测试（y + 成功）：checkConnectivity 收到候选三元组，照常落盘', async () => {
    const { ctx, lines } = makeCtx(cfg());
    const check = vi.fn(async () => ({ ok: true, elapsedMs: 42 }));
    const cmd = createModelCommand({ ...scriptedAsk(['', 'https://api.x.com/v1', 'sk-new-7777', 'x-model', 'y']), checkConnectivity: check });
    await cmd.execute('/model add x1', ctx);

    expect(check).toHaveBeenCalledWith({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-new-7777', name: 'x-model' });
    expect(logsOf(lines)).toContain('连接成功');
    expect(updateScopeMock).toHaveBeenCalledTimes(1); // 补录询问（答案耗尽为空串）自动跳过
    const [, partial] = updateScopeMock.mock.calls[0];
    expect(partial.models.profiles.x1.apiKey).toBe('sk-new-7777');
  });

  it('可选连通性测试（y + 失败）：黄字提示不影响登记', async () => {
    const { ctx, lines } = makeCtx(cfg());
    const check = vi.fn(async () => ({ ok: false, error: '401 无效密钥' }));
    const cmd = createModelCommand({ ...scriptedAsk(['', 'u', 'k', 'x-model', 'y']), checkConnectivity: check });
    await cmd.execute('/model add x1', ctx);

    expect(logsOf(lines)).toContain('连接失败：401 无效密钥');
    expect(logsOf(lines)).toContain('不影响登记');
    expect(updateScopeMock).toHaveBeenCalledTimes(1);
  });

  it('补录当前生效模型（y）：第二次 updateScope 写入快照三元组，激活状态不变', async () => {
    const { ctx, lines } = makeCtx(cfg());
    // 依次：写入位置、baseUrl、apiKey、name、连通性（跳过）、补录确认 y、补录别名
    const cmd = createModelCommand(scriptedAsk(['', 'u', 'k', 'x-model', '', 'y', 'legacy']));
    await cmd.execute('/model add x1', ctx);

    expect(updateScopeMock).toHaveBeenCalledTimes(2);
    const [, first] = updateScopeMock.mock.calls[0];
    expect(first.models.profiles.x1).toEqual({ name: 'x-model', baseUrl: 'u', apiKey: 'k' });
    const [scope, second] = updateScopeMock.mock.calls[1];
    expect(scope).toBe('workspace');
    expect(second.models.profiles.legacy).toEqual({
      name: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-main-9999',
    });
    expect(second.models).not.toHaveProperty('active');
    expect(logsOf(lines)).toContain('已补录 profile legacy');
  });

  it('生效快照已在登记簿：不触发补录询问', async () => {
    const m = model();
    const { ctx, lines } = makeCtx(cfg({ active: 'main', profiles: { main: { name: m.name, baseUrl: m.baseUrl, apiKey: m.apiKey } } }));
    // 依次：写入位置、baseUrl、apiKey、name、连通性（跳过）；快照已登记，之后不应再有补录写入
    const cmd = createModelCommand(scriptedAsk(['', 'u', 'k', 'x-model', '']));
    await cmd.execute('/model add x1', ctx);

    expect(updateScopeMock).toHaveBeenCalledTimes(1);
    expect(logsOf(lines)).not.toContain('已补录 profile');
  });
});

describe('/model test', () => {
  it('连通成功：checkConnectivity 收到 profile 三元组，输出耗时且激活状态未变', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile() } }));
    const check = vi.fn(async () => ({ ok: true, elapsedMs: 88 }));
    const cmd = createModelCommand({ checkConnectivity: check });
    await cmd.execute('/model test glm', ctx);

    expect(check).toHaveBeenCalledWith(profile());
    const text = logsOf(lines);
    expect(text).toContain('「glm」连接成功');
    expect(text).toContain('88 ms');
    expect(text).toContain('激活状态未变');
    expect(updateScopeMock).not.toHaveBeenCalled();
  });

  it('未知别名：报错列候选，不发起测试', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile() } }));
    const check = vi.fn();
    const cmd = createModelCommand({ checkConnectivity: check });
    await cmd.execute('/model test nope', ctx);

    expect(check).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('未找到模型「nope」');
    expect(logsOf(lines)).toContain('glm');
  });

  it('profile 无 apiKey：拦截并提示 config set 补救', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile({ apiKey: '' }) } }));
    const check = vi.fn();
    const cmd = createModelCommand({ checkConnectivity: check });
    await cmd.execute('/model test glm', ctx);

    expect(check).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('未配置 apiKey');
    expect(logsOf(lines)).toContain('models.profiles.glm.apiKey');
  });
});

describe('/model remove', () => {
  it('激活中的别名拒绝移除', async () => {
    const { ctx, lines } = makeCtx(cfg({ active: 'glm', profiles: { glm: profile() } }));
    const cmd = createModelCommand();
    await cmd.execute('/model remove glm', ctx);

    expect(deleteScopeKeyMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('当前激活模型');
  });

  it('目标层无此登记但另一层有：提示加 scope 重试', async () => {
    const { ctx, lines } = makeCtx(
      cfg({ profiles: { glm: profile() } }),
      { workspace: {}, global: { models: { profiles: { glm: profile() } } } },
    );
    const cmd = createModelCommand();
    await cmd.execute('/model remove glm', ctx);

    expect(deleteScopeKeyMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('--global');
  });

  it('正常移除：deleteScopeKey 收到完整键路径，且不动 model.*', async () => {
    const { ctx, lines } = makeCtx(
      cfg({ active: 'main', profiles: { glm: profile() } }),
      { workspace: { models: { profiles: { glm: profile() } } } },
    );
    const cmd = createModelCommand();
    await cmd.execute('/model remove glm', ctx);

    expect(deleteScopeKeyMock).toHaveBeenCalledWith('workspace', ['models', 'profiles', 'glm']);
    expect(logsOf(lines)).toContain('已从工作空间移除模型「glm」');
  });

  it('两层都不存在：报错列候选', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile() } }), { workspace: {}, global: {} });
    const cmd = createModelCommand();
    await cmd.execute('/model remove ghost', ctx);

    expect(deleteScopeKeyMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('未找到模型「ghost」');
  });
});

describe('/model list', () => {
  it('空登记簿：单模型兼容态 + 引导提示，key 不明文', async () => {
    const { ctx, lines } = makeCtx(cfg());
    const cmd = createModelCommand();
    await cmd.execute('/model list', ctx);

    const text = logsOf(lines);
    expect(text).toContain('单模型模式');
    expect(text).toContain('deepseek-v4-flash @ https://api.deepseek.com/v1');
    expect(text).toContain('/model add');
    expect(text).not.toContain('sk-main-9999');
    expect(text).toContain('****9999');
  });

  it('有登记簿：激活项标记、key 遮蔽、来源显示', async () => {
    const { ctx, lines } = makeCtx(cfg({ active: 'glm', profiles: { glm: profile(), k2: profile({ apiKey: 'sk-k2-1234' }) } }));
    const cmd = createModelCommand();
    await cmd.execute('/model', ctx);

    const text = logsOf(lines);
    expect(text).toContain('→ glm');
    expect(text).toContain('****abcd');
    expect(text).toContain('****1234');
    expect(text).not.toContain('sk-glm-abcd');
    expect(text).not.toContain('sk-k2-1234');
    expect(text).toContain('当前激活: glm');
  });

  it('漂移：激活 profile 与快照不一致时警示', async () => {
    const { ctx, lines } = makeCtx(
      cfg({ active: 'glm', profiles: { glm: profile() }, model: model({ baseUrl: 'https://other.example.com/v1' }) }),
    );
    const cmd = createModelCommand();
    await cmd.execute('/model list', ctx);

    expect(logsOf(lines)).toContain('不一致');
  });
});
