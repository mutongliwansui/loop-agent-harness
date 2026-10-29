// /model 命令处理器（Task-20261011-002 P0：多模型接入与切换）
// 支持: list（默认）, use <别名>, add <别名>, remove <别名>
// models.profiles 是登记簿（Record 深合并、global 与 workspace 跨层叠加），
// model.* 是运行时唯一读取的生效快照；切换 = 写 models.active + 同步 model.* 快照，
// 运行时每次动态读配置，写盘即生效（零重启）
import { createMaskedAsk } from '../bootstrap/wizard.js';
import type { ConfigLoader, ConfigScope, ConfigSource, PartialAgentConfig } from '../config/index.js';
import { DEFAULT_CONFIG, detectDrift, type AgentConfig, type ModelProfile } from '../config/schema.js';
import { defaultCheckConnectivity, type CheckConnectivityFn } from '../llm/connectivity.js';
import { COLORS, sourceColor } from '../ui/colors.js';
import { Spinner } from '../ui/spinner.js';
import { createBenchRunner, type BenchCommand } from './bench-command.js';
import { parseScope } from './utils.js';
import type { CommandContext, CommandHandler } from './registry.js';

// 漂移检测实现在 config/schema.ts（Banner 渲染共用），此处 re-export 保持既有 API
export { detectDrift } from '../config/schema.js';

export type AskFn = (prompt: string) => Promise<string>;

/** 可注入依赖（单测模拟交互输入；默认基于 ctx.rl） */
export interface ModelCommandDeps {
  ask?: AskFn;
  askSecret?: AskFn;
  /** 连通性校验（默认 openai SDK 直接 ping；add 可选测试与 /model test 共用） */
  checkConnectivity?: CheckConnectivityFn;
  /** 测速子命令（默认真实实现；单测可注入 fake 引擎与临时历史目录） */
  bench?: BenchCommand;
}

/** apiKey 展示遮蔽：仅保留尾 4 位 */
export function maskKey(key: string): string {
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

/**
 * 构造 /model use 的写入内容（D3 激活即同步快照）：
 * models.active 指针 + model.name/baseUrl/apiKey 快照；
 * profile 未定义 temperature 时不携带该键（deepMerge 跳过 undefined，保留现值）
 */
export function buildUsePartial(alias: string, profile: ModelProfile): PartialAgentConfig {
  return {
    models: { active: alias },
    model: {
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    },
  };
}

/** 读取某一层的原始配置（不存在/损坏返回 null）——用于跨层冲突与归属检测 */
export async function readLayerRaw(loader: ConfigLoader, scope: ConfigScope): Promise<PartialAgentConfig | null> {
  try {
    return scope === 'workspace' ? await loader.loadWorkspace() : await loader.loadGlobal();
  } catch {
    return null;
  }
}

/** 收集 workspace 层会覆盖全局切换的冲突键（model.* 与 models.active） */
export function collectConflictKeys(raw: PartialAgentConfig | null): string[] {
  if (!raw) return [];
  const keys: string[] = [];
  if (raw.model) keys.push(...Object.keys(raw.model).map((k) => `model.${k}`));
  if (raw.models?.active !== undefined) keys.push('models.active');
  return keys;
}

function srcTag(sources: Record<string, ConfigSource>, key: string): string {
  const src = sources[key];
  if (!src) return '';
  return ` ${COLORS.gray}(${sourceColor(src)}${src}${COLORS.reset}${COLORS.gray})${COLORS.reset}`;
}

/** 基于 ctx.rl 的提问（deps 未注入 ask 时的默认实现） */
function rlAsk(ctx: CommandContext): AskFn {
  return (prompt) => new Promise<string>((resolve) => ctx.rl.question(prompt, resolve));
}

/** y/yes 判定（交互确认；空串/其他一律视为否） */
function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

function aliasExists(cfg: AgentConfig, alias: string): boolean {
  return cfg.models.profiles[alias] !== undefined;
}

function aliasList(cfg: AgentConfig): string {
  const names = Object.keys(cfg.models.profiles);
  return names.length > 0 ? names.join('、') : '（空）';
}

/** 校验别名：非空、无空白、不以 - 开头（避免与 flag 混淆） */
export function validAlias(alias: string): boolean {
  return alias.length > 0 && !/\s/.test(alias) && !alias.startsWith('-');
}

function printList(ctx: CommandContext): void {
  const { out } = ctx;
  const { config: cfg, sources } = ctx.configLoader.load();
  const aliases = Object.keys(cfg.models.profiles).sort();
  const drift = detectDrift(cfg);

  out.blank();
  if (aliases.length === 0) {
    out.log(`${COLORS.bold}模型登记簿:${COLORS.reset} 尚未登记任何模型（当前为单模型模式）`);
    out.log(`  当前生效: ${cfg.model.name} @ ${cfg.model.baseUrl}  key ${maskKey(cfg.model.apiKey)}${srcTag(sources, 'model.name')}`);
    out.log(`  ${COLORS.gray}提示: /model add <别名> 登记模型后，即可 /model use <别名> 一键切换${COLORS.reset}`);
    out.blank();
    return;
  }

  out.log(`${COLORS.bold}模型登记簿 (${aliases.length}):${COLORS.reset}`);
  for (const alias of aliases) {
    const p = cfg.models.profiles[alias];
    const mark = alias === cfg.models.active ? `${COLORS.green}→${COLORS.reset}` : ' ';
    out.log(
      `  ${mark} ${COLORS.bold}${alias}${COLORS.reset}  ${p.name} @ ${p.baseUrl}`
      + `  key ${maskKey(p.apiKey)}${srcTag(sources, `models.profiles.${alias}.name`)}`,
    );
  }
  if (cfg.models.active) {
    out.log(`  当前激活: ${cfg.models.active}${srcTag(sources, 'models.active')}，切换: /model use <别名>`);
  } else {
    out.log(`  当前生效快照: ${cfg.model.name} @ ${cfg.model.baseUrl}  key ${maskKey(cfg.model.apiKey)}${srcTag(sources, 'model.name')}（未通过 /model 管理）`);
  }
  if (drift) out.log(`  ${COLORS.yellow}⚠ ${drift}${COLORS.reset}`);
  out.blank();
}

async function runUse(ctx: CommandContext, args: string[], deps: ModelCommandDeps): Promise<void> {
  const { out } = ctx;
  const { scope, rest } = parseScope(args);
  const alias = rest[0] ?? '';
  if (!validAlias(alias)) {
    out.blank();
    out.log(`${COLORS.red}用法: /model use <别名> [--workspace|--global]${COLORS.reset}`);
    out.log(`${COLORS.gray}已登记: ${aliasList(ctx.configLoader.load().config)}${COLORS.reset}`);
    out.blank();
    return;
  }

  const { config: cfg } = ctx.configLoader.load();
  const profile = cfg.models.profiles[alias];
  if (!profile) {
    out.blank();
    out.log(`${COLORS.red}✗ 未找到模型「${alias}」。已登记: ${aliasList(cfg)}${COLORS.reset}`);
    out.blank();
    return;
  }
  if (!profile.apiKey) {
    out.blank();
    out.log(`${COLORS.red}✗ profile「${alias}」未配置 apiKey，无法激活${COLORS.reset}`);
    out.log(`${COLORS.gray}  可执行 /config set models.profiles.${alias}.apiKey <key> 补充后重试${COLORS.reset}`);
    out.blank();
    return;
  }

  // D5：--global 切换时，workspace 层的 model.*/models.active 优先级更高，会盖住全局切换。
  // P1：交互 y/N 确认后自动清理工作空间冲突键（二者本就是生效快照，由 /model 接管）
  if (scope === 'global') {
    const wsRaw = await readLayerRaw(ctx.configLoader, 'workspace');
    const conflicts = collectConflictKeys(wsRaw);
    if (conflicts.length > 0) {
      out.blank();
      out.log(`${COLORS.yellow}⚠ 工作空间层存在同键配置（${conflicts.join(', ')}），优先级高于全局，本次全局切换可能不生效${COLORS.reset}`);
      const ask = deps.ask ?? rlAsk(ctx);
      const cleanup = isYes(
        await ask(`是否自动清理工作空间冲突键，使本次全局切换生效？[y/N]: `),
      );
      if (cleanup) {
        try {
          for (const key of conflicts) {
            await ctx.configWriter.deleteScopeKey('workspace', key.split('.'));
          }
          out.log(`${COLORS.green}✓ 已清理工作空间冲突键（${conflicts.join(', ')}）${COLORS.reset}`);
        } catch (err) {
          out.log(`${COLORS.red}✗ 清理失败：${err instanceof Error ? err.message : String(err)}${COLORS.reset}`);
        }
      } else {
        out.log(`${COLORS.gray}  可改用 /model use ${alias}（默认写工作空间）或 /config delete <键> --workspace 清理${COLORS.reset}`);
      }
    }
  }

  await ctx.configWriter.updateScope(scope, buildUsePartial(alias, profile));
  out.blank();
  out.log(
    `${COLORS.bold}${COLORS.green}✓ 已切换激活模型: ${alias}${COLORS.reset}`
    + `（${profile.name} @ ${profile.baseUrl}，写入${scope === 'workspace' ? '工作空间' : '全局'}）`,
  );
  out.log(`${COLORS.gray}  下一次对话即生效，无需重启${COLORS.reset}`);
  out.blank();
}

async function runAdd(ctx: CommandContext, args: string[], deps: ModelCommandDeps): Promise<void> {
  const { out } = ctx;
  const { scope: flagScope, rest, explicit } = parseScope(args);
  const alias = rest[0] ?? '';
  if (!validAlias(alias)) {
    out.blank();
    out.log(`${COLORS.red}用法: /model add <别名> [--workspace|--global]（别名不能含空格、不以 - 开头）${COLORS.reset}`);
    out.blank();
    return;
  }

  const { config: cfg } = ctx.configLoader.load();
  if (aliasExists(cfg, alias)) {
    out.blank();
    out.log(`${COLORS.red}✗ 别名「${alias}」已存在。如需修改可先 /model remove ${alias} 再重新 add${COLORS.reset}`);
    out.blank();
    return;
  }

  const ask = deps.ask ?? rlAsk(ctx);
  const askSecret = deps.askSecret ?? createMaskedAsk(ctx.rl);

  // 写入位置：命令行 flag 显式指定时直接采用，否则交互选择（回车默认工作空间）
  let scope = flagScope;
  if (!explicit) {
    const answer = (
      await ask('写入位置 [1] 工作空间（仅当前项目）/ [2] 全局（所有项目共享），默认 1: ')
    ).trim().toLowerCase();
    if (answer === '2' || answer === 'global' || answer === 'g') scope = 'global';
  }

  const defaultBaseUrl = cfg.model.baseUrl || DEFAULT_CONFIG.model.baseUrl;
  const baseUrl = (await ask(`服务地址 [${defaultBaseUrl}]: `)).trim() || defaultBaseUrl;

  let apiKey = '';
  while (apiKey === '') {
    apiKey = (await askSecret('apiKey（必填，输入以 * 遮蔽）: ')).trim();
    if (apiKey === '') out.log(`${COLORS.yellow}apiKey 不能为空，请重新输入。${COLORS.reset}`);
  }

  const defaultName = cfg.model.name || DEFAULT_CONFIG.model.name;
  let name = '';
  while (name === '') {
    name = (await ask(`模型名称 [${defaultName}]: `)).trim() || defaultName;
    if (name === '') out.log(`${COLORS.yellow}模型名称不能为空，请重新输入。${COLORS.reset}`);
  }

  // P1：可选连通性测试（默认跳过；失败不影响登记，可稍后 /model test 重测）
  if (isYes(await ask('是否测试连通性？[y/N]: '))) {
    const spinner = new Spinner();
    spinner.start(`正在验证 ${name} 连通性…`);
    const result = await (deps.checkConnectivity ?? defaultCheckConnectivity)({ baseUrl, apiKey, name });
    spinner.stop();
    if (result.ok) {
      out.log(`${COLORS.green}✓ 连接成功（${result.elapsedMs ?? 0} ms）${COLORS.reset}`);
    } else {
      out.log(`${COLORS.yellow}⚠ 连接失败：${result.error ?? '未知错误'}（不影响登记，可稍后 /model test ${alias} 重测）${COLORS.reset}`);
    }
  }

  const profile: ModelProfile = { name, baseUrl, apiKey };
  await ctx.configWriter.updateScope(scope, { models: { profiles: { [alias]: profile } } });

  out.blank();
  out.log(
    `${COLORS.bold}${COLORS.green}✓ 已登记模型「${alias}」${COLORS.reset}`
    + `（${name} @ ${baseUrl}，key ${maskKey(apiKey)}，写入${scope === 'workspace' ? '工作空间' : '全局'}）`,
  );
  out.log(`${COLORS.gray}  激活: /model use ${alias}${COLORS.reset}`);

  // P1：当前生效模型未登记时补录询问（避免旧模型缺席登记簿，来回切换时无从选起）
  const { config: after } = ctx.configLoader.load();
  const snapRegistered = Object.values(after.models.profiles).some(
    (p) => p.name === after.model.name && p.baseUrl === after.model.baseUrl,
  );
  if (!snapRegistered) {
    const registerOld = isYes(
      await ask(`是否将当前生效模型（${after.model.name} @ ${after.model.baseUrl}）也登记为 profile？[y/N]: `),
    );
    if (registerOld) {
      const aliasInput = (await ask('profile 别名 [default]: ')).trim() || 'default';
      if (!validAlias(aliasInput)) {
        out.log(`${COLORS.yellow}⚠ 别名不合法，已跳过补录${COLORS.reset}`);
      } else if (after.models.profiles[aliasInput] !== undefined) {
        out.log(`${COLORS.yellow}⚠ 别名「${aliasInput}」已存在，已跳过补录${COLORS.reset}`);
      } else {
        await ctx.configWriter.updateScope(scope, {
          models: {
            profiles: {
              [aliasInput]: { name: after.model.name, baseUrl: after.model.baseUrl, apiKey: after.model.apiKey },
            },
          },
        });
        out.log(`${COLORS.gray}  已补录 profile ${aliasInput}（当前生效快照，激活状态不变）${COLORS.reset}`);
      }
    }
  }
  out.blank();
}

async function runRemove(ctx: CommandContext, args: string[]): Promise<void> {
  const { out } = ctx;
  const { scope, rest } = parseScope(args);
  const alias = rest[0] ?? '';
  if (!validAlias(alias)) {
    out.blank();
    out.log(`${COLORS.red}用法: /model remove <别名> [--workspace|--global]${COLORS.reset}`);
    out.blank();
    return;
  }

  const { config: cfg } = ctx.configLoader.load();
  if (alias === cfg.models.active) {
    out.blank();
    out.log(`${COLORS.red}✗ 「${alias}」是当前激活模型，不能移除。请先 /model use <其他别名>${COLORS.reset}`);
    out.blank();
    return;
  }

  const targetRaw = await readLayerRaw(ctx.configLoader, scope);
  const inTarget = targetRaw?.models?.profiles?.[alias] !== undefined;
  if (!inTarget) {
    const otherScope: ConfigScope = scope === 'workspace' ? 'global' : 'workspace';
    const otherRaw = await readLayerRaw(ctx.configLoader, otherScope);
    if (otherRaw?.models?.profiles?.[alias] !== undefined) {
      out.blank();
      out.log(`${COLORS.red}✗ 「${alias}」未在${scope === 'workspace' ? '工作空间' : '全局'}登记，但存在于${otherScope === 'workspace' ? '工作空间' : '全局'}${COLORS.reset}`);
      out.log(`${COLORS.gray}  请加 ${otherScope === 'workspace' ? '--workspace' : '--global'} 重试: /model remove ${alias} --${otherScope}${COLORS.reset}`);
      out.blank();
      return;
    }
    out.blank();
    out.log(`${COLORS.red}✗ 未找到模型「${alias}」。已登记: ${aliasList(cfg)}${COLORS.reset}`);
    out.blank();
    return;
  }

  await ctx.configWriter.deleteScopeKey(scope, ['models', 'profiles', alias]);
  out.blank();
  out.log(`${COLORS.bold}${COLORS.green}✓ 已从${scope === 'workspace' ? '工作空间' : '全局'}移除模型「${alias}」${COLORS.reset}`);
  out.log(`${COLORS.gray}  当前生效快照（model.*）不受影响${COLORS.reset}`);
  out.blank();
}

/** /model test：对指定 profile 发起连通性测试（不改变激活状态） */
async function runTest(ctx: CommandContext, args: string[], deps: ModelCommandDeps): Promise<void> {
  const { out } = ctx;
  const { rest } = parseScope(args);
  const alias = rest[0] ?? '';
  if (!validAlias(alias)) {
    out.blank();
    out.log(`${COLORS.red}用法: /model test <别名>${COLORS.reset}`);
    out.log(`${COLORS.gray}已登记: ${aliasList(ctx.configLoader.load().config)}${COLORS.reset}`);
    out.blank();
    return;
  }

  const { config: cfg } = ctx.configLoader.load();
  const profile = cfg.models.profiles[alias];
  if (!profile) {
    out.blank();
    out.log(`${COLORS.red}✗ 未找到模型「${alias}」。已登记: ${aliasList(cfg)}${COLORS.reset}`);
    out.blank();
    return;
  }
  if (!profile.apiKey) {
    out.blank();
    out.log(`${COLORS.red}✗ profile「${alias}」未配置 apiKey，无法测试${COLORS.reset}`);
    out.log(`${COLORS.gray}  可执行 /config set models.profiles.${alias}.apiKey <key> 补充后重试${COLORS.reset}`);
    out.blank();
    return;
  }

  const spinner = new Spinner();
  spinner.start(`正在测试「${alias}」（${profile.name}）连通性…`);
  const result = await (deps.checkConnectivity ?? defaultCheckConnectivity)(profile);
  spinner.stop();
  out.blank();
  if (result.ok) {
    out.log(`${COLORS.bold}${COLORS.green}✓ 「${alias}」连接成功${COLORS.reset}（模型 ${profile.name}，${result.elapsedMs ?? 0} ms，激活状态未变）`);
  } else {
    out.log(`${COLORS.bold}${COLORS.red}✗ 「${alias}」连接失败：${result.error ?? '未知错误'}${COLORS.reset}`);
  }
  out.blank();
}

export function createModelCommand(deps: ModelCommandDeps = {}): CommandHandler {
  const bench = deps.bench ?? createBenchRunner();
  return {
    name: '/model',
    description: '多模型接入与切换（list/use/add/remove/test/bench）',
    subcommands: ['list', 'use', 'add', 'remove', 'test', 'bench', 'help'],
    subcommandHelp: {
      list: '列出登记簿中的全部模型',
      use: '切换当前模型（/model use <别名>）',
      add: '登记新模型（/model add <别名>，交互式输入配置）',
      remove: '移除模型（/model remove <别名>）',
      test: '测试模型连通性（/model test <别名>）',
      bench: '模型性能测速（/model bench [别名…]，history 查历史，help 看用法）',
    },
    match: (input) => /^\/model(?:\s|$)/i.test(input.trim()),
    async execute(input, ctx) {
      const { out } = ctx;
      const parts = input.split(/\s+/);
      const sub = parts[1] ?? 'list';
      const args = parts.slice(2);

      if (sub === 'list') {
        printList(ctx);
        return;
      }
      if (sub === 'use') {
        await runUse(ctx, args, deps);
        return;
      }
      if (sub === 'add') {
        await runAdd(ctx, args, deps);
        return;
      }
      if (sub === 'remove') {
        await runRemove(ctx, args);
        return;
      }
      if (sub === 'test') {
        await runTest(ctx, args, deps);
        return;
      }
      if (sub === 'bench') {
        await bench.execute(args, ctx);
        return;
      }

      out.blank();
      out.log(`${COLORS.red}未知子命令: ${sub}${COLORS.reset}`);
      out.log(`用法: /model list | /model use <别名> | /model add <别名> | /model remove <别名> | /model test <别名> | /model bench [别名…]`);
      out.blank();
    },
  };
}

export const modelCommand: CommandHandler = createModelCommand();
