// 配置向导单测：注入 ask/校验/写盘依赖，模拟输入序列（Task-20261011-001 6.7/6.11/6.13/6.14）
// P1 追加：apiKey 遮蔽回显（纯函数 + PassThrough 集成）、deps.rl 注入、preferredScope、损坏配置备份接线
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import readline from 'node:readline';
import {
  runWizard,
  maskEchoChunk,
  createMaskedAsk,
  type WizardDeps,
  type ModelCandidate,
} from '../src/bootstrap/wizard.js';
import { configWriter } from '../src/config/index.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import type { BootstrapReport } from '../src/bootstrap/doctor.js';

// 备份接线测试用：configWriter mock 到临时固定路径（updateScope 不真写盘）
vi.mock('../src/config/index.js', async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = join(tmpdir(), 'loop-agent-wizard-bak-test');
  return {
    configWriter: {
      globalConfigPath: join(dir, 'config.json'),
      workspaceConfigPath: join(dir, '.agent-config.json'),
      updateScope: vi.fn(async () => undefined),
    },
  };
});

const BAK_DIR = join(tmpdir(), 'loop-agent-wizard-bak-test');
const BAK_GLOBAL = join(BAK_DIR, 'config.json');

const blockerReport: BootstrapReport = {
  ok: false,
  issues: [{ id: 'model-apiKey', level: 'blocker', message: '主模型 apiKey 未配置' }],
};

interface Harness {
  deps: WizardDeps;
  out: string[];
  writes: Array<{ scope: 'global' | 'workspace'; candidate: ModelCandidate }>;
  scaffoldCount: () => number;
  closeCount: () => number;
}

function makeHarness(
  answers: string[],
  checkResults: Array<{ ok: boolean; error?: string; elapsedMs?: number }> = [
    { ok: true, elapsedMs: 42 },
  ],
): Harness {
  const out: string[] = [];
  const writes: Harness['writes'] = [];
  let ai = 0;
  let ci = 0;
  let scaffolds = 0;
  let closes = 0;
  const deps: WizardDeps = {
    ask: async () => answers[ai++] ?? '',
    checkConnectivity: async () => checkResults[Math.min(ci++, checkResults.length - 1)],
    writeConfig: async (scope, candidate) => {
      writes.push({ scope, candidate });
      return '/fake/config.json';
    },
    scaffold: async () => {
      scaffolds++;
      return ['/fake/skills'];
    },
    out: (line = '') => out.push(line),
    close: () => {
      closes++;
    },
  };
  return { deps, out, writes, scaffoldCount: () => scaffolds, closeCount: () => closes };
}

function outText(out: string[]): string {
  return out.join('\n');
}

describe('runWizard（初次启动配置向导）', () => {
  it('完整流程：默认值回车跳过、校验通过、默认写入全局', async () => {
    const h = makeHarness(['', 'sk-test-1234', '', '']);
    await runWizard(blockerReport, DEFAULT_CONFIG, h.deps);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].scope).toBe('global');
    expect(h.writes[0].candidate.baseUrl).toBe(DEFAULT_CONFIG.model.baseUrl);
    expect(h.writes[0].candidate.apiKey).toBe('sk-test-1234');
    expect(h.writes[0].candidate.name).toBe(DEFAULT_CONFIG.model.name);

    const text = outText(h.out);
    expect(text).toContain('初始化向导');
    expect(text).toContain('主模型 apiKey 未配置');
    expect(text).toContain('已创建: /fake/skills');
    expect(text).toContain('初始化完成');
    expect(text).toContain('****1234');
    expect(text).not.toContain('sk-test-1234');
    expect(text).toContain('已验证');
    expect(h.scaffoldCount()).toBe(1);
    expect(h.closeCount()).toBe(1);
  });

  it('apiKey 空输入时重新提示', async () => {
    const h = makeHarness(['', '', 'sk-abc', '', '']);
    await runWizard(blockerReport, DEFAULT_CONFIG, h.deps);

    expect(h.writes[0].candidate.apiKey).toBe('sk-abc');
    expect(outText(h.out)).toContain('apiKey 不能为空');
  });

  it('校验失败选择仍保存：摘要标注未验证', async () => {
    const h = makeHarness(['', 'sk-x', '', 's', ''], [
      { ok: false, error: 'apiKey 无效或无权限' },
    ]);
    await runWizard(blockerReport, DEFAULT_CONFIG, h.deps);

    expect(h.writes).toHaveLength(1);
    const text = outText(h.out);
    expect(text).toContain('连接失败：apiKey 无效或无权限');
    expect(text).toContain('未验证');
    expect(text).not.toContain('已验证');
  });

  it('校验失败选择重试：重试成功后标注已验证', async () => {
    const h = makeHarness(['', 'sk-x', '', 'r', ''], [
      { ok: false, error: '无法连接到服务地址：ECONNREFUSED' },
      { ok: true, elapsedMs: 10 },
    ]);
    await runWizard(blockerReport, DEFAULT_CONFIG, h.deps);

    expect(h.writes).toHaveLength(1);
    expect(outText(h.out)).toContain('已验证');
  });

  it('校验失败选择重新输入：以新三元组重新校验并写入', async () => {
    const h = makeHarness(
      ['', 'sk-bad', '', 'e', 'https://api.example.com/v1', 'sk-good', 'deepseek-chat', ''],
      [{ ok: false, error: '模型名或服务地址可能有误' }, { ok: true, elapsedMs: 5 }],
    );
    await runWizard(blockerReport, DEFAULT_CONFIG, h.deps);

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].candidate.baseUrl).toBe('https://api.example.com/v1');
    expect(h.writes[0].candidate.apiKey).toBe('sk-good');
    expect(h.writes[0].candidate.name).toBe('deepseek-chat');
    expect(outText(h.out)).toContain('已验证');
  });

  it('写入位置选择 workspace 时按工作空间写盘', async () => {
    const h = makeHarness(['', 'sk-1', '', 'workspace']);
    await runWizard(blockerReport, DEFAULT_CONFIG, h.deps);

    expect(h.writes[0].scope).toBe('workspace');
  });

  it('支持自定义 baseUrl 与模型名', async () => {
    const h = makeHarness(['https://api.deepseek.com/v1', 'sk-1', 'deepseek-chat', '']);
    await runWizard(blockerReport, DEFAULT_CONFIG, h.deps);

    expect(h.writes[0].candidate.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(h.writes[0].candidate.name).toBe('deepseek-chat');
  });
});

describe('maskEchoChunk（apiKey 遮蔽回显，纯函数，Task-20261011-001 3.7）', () => {
  it('普通可见字符遮蔽为 *，长度不变', () => {
    expect(maskEchoChunk('key: ', 'a')).toBe('*');
    expect(maskEchoChunk('key: ', 'sk-1')).toBe('****');
  });

  it('控制字符保留；空格等可见字符（含擦除序列中的）一律遮蔽，不泄露明文', () => {
    expect(maskEchoChunk('key: ', '\b')).toBe('\b');
    expect(maskEchoChunk('key: ', '\b \b')).toBe('\b*\b');
    expect(maskEchoChunk('key: ', '\r\n')).toBe('\r\n');
  });

  it('ANSI 转义序列原样保留', () => {
    expect(maskEchoChunk('key: ', '\x1b[2K\x1b[1G')).toBe('\x1b[2K\x1b[1G');
  });

  it('含 prompt 的整行刷新：保留 prompt、遮蔽内容（星号数随输入同步）', () => {
    expect(maskEchoChunk('key: ', 'key: sk-1')).toBe('key: ****');
  });

  it('混合 chunk：控制序列 + 整行 + 尾部清行序列', () => {
    expect(maskEchoChunk('key: ', '\x1b[2Kkey: ab\x1b[0K')).toBe('\x1b[2Kkey: **\x1b[0K');
  });

  it('prompt 之前的可见字符也被遮蔽', () => {
    expect(maskEchoChunk('key: ', 'x\x1b[1Gkey: y')).toBe('*\x1b[1Gkey: *');
  });

  it('中文 prompt 正确保留', () => {
    const p = '模型 apiKey（必填，输入以 * 遮蔽）: ';
    expect(maskEchoChunk(p, p + 'abc')).toBe(p + '***');
  });
});

describe('createMaskedAsk（遮蔽回显集成，PassThrough）', () => {
  // 注：Node 24 + PassThrough 下 readline 的退格编辑行为不可靠（keypress 解码正确但
  // Interface 未执行删除）；退格重绘逻辑由下方 maskEchoChunk 纯函数用例覆盖，
  // 真实 TTY 行为在真机验证（验收 6.18）兜底。此处仅做无退格的遮蔽集成断言。
  it('输入 abc + 回车后答案为 abc，回显只有 * 不含明文', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (d: Buffer) => chunks.push(d.toString()));
    const rl = readline.createInterface({ input, output, terminal: true });
    const askSecret = createMaskedAsk(rl);

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const pending = askSecret('key: ');
    input.write('abc');
    await delay(30);
    input.write('\r');
    const answer = await pending;
    rl.close();
    input.destroy();
    output.destroy();

    expect(answer).toBe('abc');
    const echoed = chunks.join('');
    expect(echoed).toContain('key: ');
    expect(echoed).toContain('*');
    expect(echoed).not.toContain('abc');
  });
});

describe('runWizard（deps.rl 注入：/setup 复用 REPL readline，6.12）', () => {
  function makeRlStub(answers: string[]): { rl: readline.Interface; prompts: string[] } {
    const prompts: string[] = [];
    const rl = {
      question: (p: string, cb: (a: string) => void) => {
        prompts.push(p);
        cb(answers.shift() ?? '');
      },
      output: { write: () => {} },
    } as unknown as readline.Interface;
    return { rl, prompts };
  }

  it('全部提问走注入的 rl，结束时不关闭外部接口（无 close 方法可调）', async () => {
    const { rl, prompts } = makeRlStub(['', 'sk-rl-1', '', '']);
    const out: string[] = [];
    let closed = false;
    await runWizard(blockerReport, DEFAULT_CONFIG, {
      rl,
      // 未注入时会走真实网络 ping；此处 stub 掉以保证连通性检查通过、提问恰为 4 个
      checkConnectivity: async () => ({ ok: true, elapsedMs: 1 }),
      out: (l = '') => out.push(l),
      close: () => {
        closed = true;
      },
    });

    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain('apiKey');
    expect(out.join('\n')).toContain('初始化完成');
    expect(closed).toBe(true); // deps.close 仍被调用
  });

  it('preferredScope=workspace 时空回车默认写 workspace，输入 g 切回 global（6.12 flag）', async () => {
    const h1 = makeHarness(['', 'sk-1', '', '']);
    await runWizard(blockerReport, DEFAULT_CONFIG, { ...h1.deps, preferredScope: 'workspace' });
    expect(h1.writes[0].scope).toBe('workspace');

    const h2 = makeHarness(['', 'sk-1', '', 'g']);
    await runWizard(blockerReport, DEFAULT_CONFIG, { ...h2.deps, preferredScope: 'workspace' });
    expect(h2.writes[0].scope).toBe('global');
  });
});

describe('runWizard 损坏配置自动备份（默认写盘路径接线，6.14）', () => {
  beforeEach(async () => {
    vi.mocked(configWriter.updateScope).mockClear();
  });

  afterEach(async () => {
    await rm(BAK_DIR, { recursive: true, force: true });
  });

  it('全局 config 为损坏 JSON 时，写盘前备份为 .bak-<时间戳> 并提示', async () => {
    await mkdir(BAK_DIR, { recursive: true });
    await writeFile(BAK_GLOBAL, '{broken json!!', 'utf-8');
    const out: string[] = [];
    let ai = 0;
    const answers = ['', 'sk-bak', '', ''];
    await runWizard(blockerReport, DEFAULT_CONFIG, {
      ask: async () => answers[ai++] ?? '',
      checkConnectivity: async () => ({ ok: true, elapsedMs: 1 }),
      scaffold: async () => [],
      out: (l = '') => out.push(l),
      close: () => {},
    });

    const text = out.join('\n');
    expect(text).toContain('已自动备份为');
    await expect(access(BAK_GLOBAL)).rejects.toThrow(); // 原路径已重命名
    const bak = (await readdir(BAK_DIR)).find((f) => f.startsWith('config.json.bak-'));
    expect(bak).toBeDefined();
    await expect(readFile(join(BAK_DIR, bak as string), 'utf-8')).resolves.toBe('{broken json!!');
    expect(vi.mocked(configWriter.updateScope).mock.calls[0][0]).toBe('global');
  });

  it('配置文件不存在时不备份、不输出提示，updateScope 仍被调用', async () => {
    await rm(BAK_DIR, { recursive: true, force: true });
    const out: string[] = [];
    let ai = 0;
    const answers = ['', 'sk-bak', '', ''];
    await runWizard(blockerReport, DEFAULT_CONFIG, {
      ask: async () => answers[ai++] ?? '',
      checkConnectivity: async () => ({ ok: true, elapsedMs: 1 }),
      scaffold: async () => [],
      out: (l = '') => out.push(l),
      close: () => {},
    });

    expect(out.join('\n')).not.toContain('已自动备份为');
    // P1 向导联动：writeConfig 一次 + 登记 default profile 一次
    expect(vi.mocked(configWriter.updateScope)).toHaveBeenCalledTimes(2);
    expect(out.join('\n')).toContain('已登记：profile default');
  });
});

describe('runWizard 向导联动（Task-20261011-002 P1 5.6：登记 default profile）', () => {
  it('profiles 为空：registerProfile 收到（scope, default, 候选三元组），输出提示', async () => {
    const h = makeHarness(['', 'sk-reg', '', '']);
    const registered: Array<{ scope: 'global' | 'workspace'; alias: string; candidate: ModelCandidate }> = [];
    await runWizard(blockerReport, DEFAULT_CONFIG, {
      ...h.deps,
      registerProfile: async (scope, alias, candidate) => {
        registered.push({ scope, alias, candidate });
      },
    });

    expect(registered).toHaveLength(1);
    expect(registered[0].scope).toBe('global');
    expect(registered[0].alias).toBe('default');
    expect(registered[0].candidate.apiKey).toBe('sk-reg');
    expect(outText(h.out)).toContain('已登记：profile default');
    expect(outText(h.out)).toContain('/model use 切换');
  });

  it('profiles 非空：不登记（既往多模型用户不受向导影响）', async () => {
    const cfgWithProfiles = {
      ...DEFAULT_CONFIG,
      models: {
        active: 'legacy',
        profiles: { legacy: { name: 'old-model', baseUrl: 'https://old.example.com/v1', apiKey: 'sk-old' } },
      },
    };
    const h = makeHarness(['', 'sk-new', '', '']);
    const registered: unknown[] = [];
    await runWizard(blockerReport, cfgWithProfiles, {
      ...h.deps,
      registerProfile: async () => {
        registered.push(1);
      },
    });

    expect(registered).toHaveLength(0);
    expect(outText(h.out)).not.toContain('已登记：profile default');
  });

  it('登记失败不阻断：黄字提示 + 摘要照常输出', async () => {
    const h = makeHarness(['', 'sk-x', '', '']);
    await runWizard(blockerReport, DEFAULT_CONFIG, {
      ...h.deps,
      registerProfile: async () => {
        throw new Error('disk full');
      },
    });

    const text = outText(h.out);
    expect(text).toContain('profile 登记失败');
    expect(text).toContain('/model add default');
    expect(text).toContain('初始化完成'); // 向导未被阻断
  });
});
