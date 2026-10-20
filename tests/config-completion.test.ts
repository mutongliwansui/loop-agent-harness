// /config 配置项 Tab 补全单测
// 覆盖：flattenConfigKeys 扁平化口径（叶子键 / 数组与 null 视为叶子 / 空对象不产出 / 排序）
//      以及与 completeCommandLineAsync 三级补全的接线（/config get|set|delete）
import { describe, it, expect } from 'vitest';
import { flattenConfigKeys, configCommand } from '../src/commands/config-command.js';
import { DEFAULT_CONFIG } from '../src/config/index.js';
import {
  CommandRegistry,
  completeCommandLineAsync,
  type ArgCompletionProvider,
} from '../src/commands/registry.js';

describe('flattenConfigKeys', () => {
  it('默认配置扁平出点路径叶子键', () => {
    const keys = flattenConfigKeys(DEFAULT_CONFIG);
    for (const k of [
      'model.name',
      'agent.maxIterations',
      'models.active',
      'agent.verbose',
      'agent.systemPrompt',
      'tools.enabled',
      'vision.enabled',
      'session.autoSave',
      'skill.enabled',
    ]) {
      expect(keys).toContain(k);
    }
  });

  it('数组与 null 视为叶子，不再下钻', () => {
    const keys = flattenConfigKeys({ tools: { enabled: ['a', 'b'] }, agent: { systemPrompt: null } });
    expect(keys).toEqual(['agent.systemPrompt', 'tools.enabled']);
    expect(keys.some((k) => k.startsWith('tools.enabled.'))).toBe(false);
  });

  it('空对象不产出候选（如未登记的 models.profiles）', () => {
    expect(flattenConfigKeys(DEFAULT_CONFIG)).not.toContain('models.profiles');
  });

  it('动态 Record 键正常下钻', () => {
    const keys = flattenConfigKeys({
      tools: { mcpServers: { demo: { type: 'stdio', command: 'node' } } },
    });
    expect(keys).toEqual(['tools.mcpServers.demo.command', 'tools.mcpServers.demo.type']);
  });

  it('结果按字典序排序', () => {
    const keys = flattenConfigKeys({ b: 1, a: { y: 1, x: 2 } });
    expect(keys).toEqual(['a.x', 'a.y', 'b']);
  });
});

describe('/config 三级补全接线', () => {
  /** 与 index.ts 中 provider 的 /config 分支保持一致 */
  const provider: ArgCompletionProvider = {
    completeArgs(command, subcommand, prefix) {
      if (
        command === '/config' &&
        (subcommand === 'get' || subcommand === 'set' || subcommand === 'delete')
      ) {
        return flattenConfigKeys(DEFAULT_CONFIG).filter((k) => k.startsWith(prefix));
      }
      return [];
    },
  };

  const makeRegistry = (): CommandRegistry => {
    const r = new CommandRegistry();
    r.register(configCommand);
    return r;
  };

  it('/config set <Tab> 列出配置项', async () => {
    const [cands] = await completeCommandLineAsync('/config set ', makeRegistry(), provider);
    expect(cands).toContain('/config set model.name');
    expect(cands).toContain('/config set vision.enabled');
  });

  it('/config set mod<Tab> 按前缀过滤', async () => {
    const [cands] = await completeCommandLineAsync('/config set mod', makeRegistry(), provider);
    expect(cands).toContain('/config set model.name');
    expect(cands.every((c) => c.startsWith('/config set model'))).toBe(true);
  });

  it('/config get / delete 同样补配置项', async () => {
    for (const sub of ['get', 'delete']) {
      const [cands] = await completeCommandLineAsync(`/config ${sub} `, makeRegistry(), provider);
      expect(cands).toContain(`/config ${sub} model.name`);
    }
  });

  it('非取值子命令（list / path）三级不补全', async () => {
    expect(await completeCommandLineAsync('/config list ', makeRegistry(), provider)).toEqual([
      [],
      '/config list ',
    ]);
  });
});
