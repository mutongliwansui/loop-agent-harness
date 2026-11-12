// /setup 命令处理器：REPL 内按需重跑初始化向导
// 复用 REPL 的 readline（避免第二个接口抢占 stdin）；写盘后即时刷新工具注册
import { runWizard } from '../bootstrap/wizard.js';
import { checkBootstrap, defaultBootstrapPaths } from '../bootstrap/doctor.js';
import { registerBuiltinTools } from '../tools/index.js';
import { COLORS } from '../ui/colors.js';
import type { ConfigScope } from '../config/index.js';
import type { CommandContext, CommandHandler } from './registry.js';

export const setupCommand: CommandHandler = {
  name: '/setup',
  description: '重跑初始化向导：模型三元组与连通性（--global/--workspace）',
  subcommands: ['--global', '--workspace', 'help'],
  subcommandHelp: {
    '--global': '向导结果写入全局配置（~/.loop-agent/）',
    '--workspace': '向导结果写入工作空间配置（<cwd>/.loop-agent/）',
  },
  match: (input) => /^\/setup(?:\s|$)/i.test(input.trim()),
  async execute(input, ctx: CommandContext) {
    const { out } = ctx;
    const lower = input.toLowerCase();
    const preferredScope: ConfigScope | undefined = lower.includes('--workspace')
      ? 'workspace'
      : lower.includes('--global')
        ? 'global'
        : undefined;

    // 以当前生效配置为向导默认值；检测报告用于欢迎区缺失清单
    const { config: cfg } = ctx.configLoader.load();
    const report = checkBootstrap(cfg, defaultBootstrapPaths());

    // 复用 REPL 的 readline；向导结束绝不关闭它（deps.close 未传 + 注入 rl 时向导不会 close）
    await runWizard(report, cfg, {
      rl: ctx.rl,
      out: (line = '') => out.log(line),
      ...(preferredScope ? { preferredScope } : {}),
    });

    // 写盘后刷新：重新加载生效值并按需注册工具（registerBuiltinTools 幂等）
    const { config: fresh } = ctx.configLoader.load();
    registerBuiltinTools(fresh.tools, fresh.vision, fresh.ocr);

    out.blank();
    out.log(`${COLORS.green}✓ 模型配置已写入，后续对话即时生效${COLORS.reset}`);
    out.log(
      `${COLORS.gray}若同时调整了工具/视觉等非模型配置，建议重启以完全生效${COLORS.reset}`,
    );
    out.blank();
  },
};
