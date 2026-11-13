/**
 * /model 多模型接入与切换单测（Task-20261011-002 P0+P1；需求 20261112-008 改写）
 *
 * 008 后配置只有全局一份，本文件相应改写：
 * - 写入位置询问与 --global/--workspace 分层已移除，updateScope→update
 * - 「--global 跨层冲突警示/清理向导」随资源层删除（collectConflictKeys 已不存在）
 * - remove 的「另一层有」分支删除，改为全局单一事实源
 *
 * 覆盖：use 写入内容（active+快照、temperature 缺省跳过）、未知别名/空 key 拦截、
 *       add 交互登记/重名中止/可选连通性/补录、remove 激活保护/正常移除、
 *       list 兼容态与漂移警示、test 三态、纯函数（maskKey/detectDrift）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../src/commands/registry.js';
import type { AgentConfig, ModelConfig, ModelProfile } from '../src/config/schema.js';

const { loadMock, loadGlobalMock, updateMock, deleteKeyMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  loadGlobalMock: vi.fn(),
  updateMock: vi.fn(),
  deleteKeyMock: vi.fn(),
}));

vi.mock('../src/config/index.js', () => ({
  configLoader: {
    load: loadMock,
    loadGlobal: loadGlobalMock,
  },
}));

// 切断 wizard 的传递依赖（真实 createMaskedAsk 依赖 readline；测试中交互均走 deps 注入）
vi.mock('../src/bootstrap/wizard.js', () => ({
  createMaskedAsk: () => async () => '',
}));

import {
  buildUsePartial,
  createModelCommand,
  detectDrift,
  maskKey,
} from '../src/commands/model-command.js';

function model(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-main-9999',
    temperature: undefined,
    ...over,
  } as ModelConfig;
}

function profile(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    name: 'glm-4.6',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'sk-glm-abcd',
    ...over,
  } as ModelProfile;
}

function cfg(opts: { active?: string; profiles?: Record<string, ModelProfile>; model?: ModelConfig } = {}): AgentConfig {
  return {
    model: opts.model ?? model(),
    models: { active: opts.active ?? '', profiles: opts.profiles ?? {} },
  } as unknown as AgentConfig;
}

function makeCtx(cfgValue: AgentConfig, layerRaw: { global?: unknown } = {}): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    configLoader: {
      load: loadMock.mockReturnValue({ config: cfgValue, sources: {} }),
      loadGlobal: loadGlobalMock.mockResolvedValue(layerRaw.global ?? null),
    },
    configWriter: { update: updateMock, deleteKey: deleteKeyMock },
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

/** 断言输出里出现给定片段（先剥离 ANSI 着色，避免颜色码切断连续文案） */
function logsOf(lines: string[]): string {
  return lines.join('\n').replace(/\u001b\[[0-9;]*m/gu, '');
}

beforeEach(() => {
  loadMock.mockReset();
  loadGlobalMock.mockReset();
  updateMock.mockReset();
  updateMock.mockResolvedValue(undefined);
  deleteKeyMock.mockReset();
  deleteKeyMock.mockResolvedValue(undefined);
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
});

describe('/model use', () => {
  it('写入全局：update 收到 active+快照', async () => {
    const { ctx } = makeCtx(cfg({ active: 'glm', profiles: { glm: profile() } }));
    const cmd = createModelCommand();
    await cmd.execute('/model use glm', ctx);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const [partial] = updateMock.mock.calls[0];
    expect(partial.models.active).toBe('glm');
    expect(partial.model.name).toBe('glm-4.6');
    expect(partial.model.apiKey).toBe('sk-glm-abcd');
  });

  it('未知别名：报错并列候选，不写盘', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile() } }));
    const cmd = createModelCommand();
    await cmd.execute('/model use nope', ctx);

    expect(updateMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('未找到模型「nope」');
    expect(logsOf(lines)).toContain('glm');
  });

  it('profile 无 apiKey：拦截不写盘并给出补救提示', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile({ apiKey: '' }) } }));
    const cmd = createModelCommand();
    await cmd.execute('/model use glm', ctx);

    expect(updateMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('未配置 apiKey');
    expect(logsOf(lines)).toContain('models.profiles.glm.apiKey');
  });

  it('--workspace 已移除：明确报错且不写盘（D10）', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile() } }));
    const cmd = createModelCommand(scriptedAsk(['']));
    await cmd.execute('/model use glm --workspace', ctx);

    expect(updateMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('工作空间级配置已移除');
  });
});

describe('/model add', () => {
  it('交互登记：写入 profiles.<别名>，key 落盘为明文、展示为遮蔽', async () => {
    const { ctx, lines } = makeCtx(cfg());
    // 依次：baseUrl、apiKey、name（008 后不再询问写入位置）
    const cmd = createModelCommand(scriptedAsk(['https://api.x.com/v1', 'sk-new-7777', 'x-model']));
    await cmd.execute('/model add x1', ctx);

    const [partial] = updateMock.mock.calls[0];
    expect(partial.models.profiles.x1).toEqual({
      name: 'x-model',
      baseUrl: 'https://api.x.com/v1',
      apiKey: 'sk-new-7777',
    });
    expect(logsOf(lines)).toContain('****7777');
    expect(logsOf(lines)).not.toContain('sk-new-7777');
  });

  it('显式 --global：行为一致，输入序列不错位', async () => {
    const { ctx } = makeCtx(cfg());
    const cmd = createModelCommand(scriptedAsk(['u', 'k', 'x-model']));
    await cmd.execute('/model add x1 --global', ctx);

    const [partial] = updateMock.mock.calls[0];
    expect(partial.models.profiles.x1).toEqual({ name: 'x-model', baseUrl: 'u', apiKey: 'k' });
  });

  it('--workspace 已移除：明确报错且不写盘（D10）', async () => {
    const { ctx, lines } = makeCtx(cfg());
    const cmd = createModelCommand(scriptedAsk(['u', 'k', 'x-model']));
    await cmd.execute('/model add x1 --workspace', ctx);

    expect(updateMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('工作空间级配置已移除');
  });

  it('重名中止：不写盘', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { x1: profile() } }));
    const cmd = createModelCommand(scriptedAsk(['u', 'k', 'n']));
    await cmd.execute('/model add x1', ctx);

    expect(updateMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('已存在');
  });

  it('非法别名（- 开头）：提示用法不写盘', async () => {
    const { ctx, lines } = makeCtx(cfg());
    const cmd = createModelCommand(scriptedAsk([]));
    await cmd.execute('/model add --global', ctx);

    expect(updateMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('用法');
  });

  it('可选连通性测试（y + 成功）：checkConnectivity 收到候选三元组，照常落盘', async () => {
    const { ctx, lines } = makeCtx(cfg());
    const check = vi.fn(async () => ({ ok: true, elapsedMs: 42 }));
    const cmd = createModelCommand({
      ...scriptedAsk(['https://api.x.com/v1', 'sk-new-7777', 'x-model', 'y']),
      checkConnectivity: check,
    });
    await cmd.execute('/model add x1', ctx);

    expect(check).toHaveBeenCalledWith({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-new-7777', name: 'x-model' });
    expect(logsOf(lines)).toContain('连接成功');
    expect(updateMock).toHaveBeenCalledTimes(1); // 补录询问（答案耗尽为空串）自动跳过
    const [partial] = updateMock.mock.calls[0];
    expect(partial.models.profiles.x1.apiKey).toBe('sk-new-7777');
  });

  it('可选连通性测试（y + 失败）：黄字提示不影响登记', async () => {
    const { ctx, lines } = makeCtx(cfg());
    const check = vi.fn(async () => ({ ok: false, error: '401 无效密钥' }));
    const cmd = createModelCommand({ ...scriptedAsk(['u', 'k', 'x-model', 'y']), checkConnectivity: check });
    await cmd.execute('/model add x1', ctx);

    expect(logsOf(lines)).toContain('连接失败：401 无效密钥');
    expect(logsOf(lines)).toContain('不影响登记');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('补录当前生效模型（y）：第二次 update 写入快照三元组，激活状态不变', async () => {
    const { ctx, lines } = makeCtx(cfg());
    // 依次：baseUrl、apiKey、name、连通性（跳过）、补录确认 y、补录别名
    const cmd = createModelCommand(scriptedAsk(['u', 'k', 'x-model', '', 'y', 'legacy']));
    await cmd.execute('/model add x1', ctx);

    expect(updateMock).toHaveBeenCalledTimes(2);
    const [first] = updateMock.mock.calls[0];
    expect(first.models.profiles.x1).toEqual({ name: 'x-model', baseUrl: 'u', apiKey: 'k' });
    const [second] = updateMock.mock.calls[1];
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
    // 依次：baseUrl、apiKey、name、连通性（跳过）；快照已登记，之后不应再有补录写入
    const cmd = createModelCommand(scriptedAsk(['u', 'k', 'x-model', '']));
    await cmd.execute('/model add x1', ctx);

    expect(updateMock).toHaveBeenCalledTimes(1);
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
    expect(updateMock).not.toHaveBeenCalled();
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

    expect(deleteKeyMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('当前激活模型');
  });

  it('正常移除：deleteKey 收到完整键路径，且不动 model.*', async () => {
    const { ctx, lines } = makeCtx(
      cfg({ active: 'main', profiles: { glm: profile() } }),
      { global: { models: { profiles: { glm: profile() } } } },
    );
    const cmd = createModelCommand();
    await cmd.execute('/model remove glm', ctx);

    expect(deleteKeyMock).toHaveBeenCalledWith(['models', 'profiles', 'glm']);
    expect(logsOf(lines)).toContain('已从全局配置移除模型「glm」');
  });

  it('全局不存在：报错列候选', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile() } }), { global: {} });
    const cmd = createModelCommand();
    await cmd.execute('/model remove ghost', ctx);

    expect(deleteKeyMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('未找到模型「ghost」');
  });

  it('--workspace 已移除：明确报错且不删盘（D10）', async () => {
    const { ctx, lines } = makeCtx(cfg({ profiles: { glm: profile() } }), { global: { models: { profiles: { glm: profile() } } } });
    const cmd = createModelCommand();
    await cmd.execute('/model remove glm --workspace', ctx);

    expect(deleteKeyMock).not.toHaveBeenCalled();
    expect(logsOf(lines)).toContain('工作空间级配置已移除');
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
