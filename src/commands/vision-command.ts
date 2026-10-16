// /vision 命令处理器（Task-20261010-001 P1）
// 支持: status（配置来源 + 缓存状态 + 会话用量）, test（视觉服务连通性测试）
import type { ConfigSource } from '../config/index.js';
import { llm } from '../llm/client.js';
import type { VisionMessage } from '../types.js';
import { COLORS, sourceColor } from '../ui/colors.js';
import { resolveVisionTargets } from '../tools/vision/tools.js';
import { visionCache } from '../tools/vision/cache.js';
import { visionStats } from '../tools/vision/stats.js';
import type { CommandContext, CommandHandler } from './registry.js';

/** 内置 1x1 透明 PNG（连通性测试用，不依赖外部资源） */
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** 来源标注片段（与 /config list 同款着色） */
function srcTag(sources: Record<string, ConfigSource>, key: string): string {
  const src = sources[key];
  if (!src) return '';
  return ` ${COLORS.gray}(${sourceColor(src)}${src}${COLORS.reset}${COLORS.gray})${COLORS.reset}`;
}

function printStatus(ctx: CommandContext): void {
  const { out } = ctx;
  const { config: cfg, sources } = ctx.configLoader.load();
  const vision = cfg.vision;
  const stats = visionStats.snapshot();

  out.blank();
  out.log(`${COLORS.bold}视觉功能状态:${COLORS.reset}`);
  out.log(`  ${COLORS.white}enabled${COLORS.reset} = ${vision.enabled}${srcTag(sources, 'vision.enabled')}`);
  out.log(`  ${COLORS.white}model${COLORS.reset} = ${vision.model || `(回退主模型 ${cfg.model.name})`}${srcTag(sources, 'vision.model')}`);
  out.log(`  ${COLORS.white}baseUrl${COLORS.reset} = ${vision.baseUrl || `(回退 ${cfg.model.baseUrl})`}${srcTag(sources, 'vision.baseUrl')}`);
  const keyDisplay = vision.apiKey ? `****${vision.apiKey.slice(-4)}` : vision.enabled ? `(回退主模型 Key ****${cfg.model.apiKey.slice(-4)})` : '(未配置)';
  out.log(`  ${COLORS.white}apiKey${COLORS.reset} = ${keyDisplay}${srcTag(sources, 'vision.apiKey')}`);
  out.log(`  ${COLORS.white}temperature${COLORS.reset} = ${vision.temperature}${srcTag(sources, 'vision.temperature')}  ${COLORS.white}maxTokens${COLORS.reset} = ${vision.maxTokens}${srcTag(sources, 'vision.maxTokens')}`);
  out.log(`  ${COLORS.white}timeoutMs${COLORS.reset} = ${vision.timeoutMs}${srcTag(sources, 'vision.timeoutMs')}  ${COLORS.white}maxImageBytes${COLORS.reset} = ${vision.maxImageBytes}${srcTag(sources, 'vision.maxImageBytes')}`);
  out.log(`  ${COLORS.white}maxResultChars${COLORS.reset} = ${vision.maxResultChars}${srcTag(sources, 'vision.maxResultChars')}  ${COLORS.white}cacheEnabled${COLORS.reset} = ${vision.cacheEnabled}${srcTag(sources, 'vision.cacheEnabled')}  ${COLORS.white}cacheTtlMs${COLORS.reset} = ${vision.cacheTtlMs}${srcTag(sources, 'vision.cacheTtlMs')}`);

  out.blank();
  out.log(`${COLORS.bold}缓存:${COLORS.reset} ${visionCache.size()} 条（LRU 上限 20）`);
  out.log(
    `${COLORS.bold}会话累计:${COLORS.reset} 调用 ${stats.calls} 次（缓存命中 ${stats.cacheHits}，失败 ${stats.errors}）`
    + ` | prompt ${stats.promptTokens} + completion ${stats.completionTokens} = ${stats.totalTokens} tokens`
    + ` | 耗时 ${stats.elapsedMs}ms`,
  );
  out.blank();
}

async function runTest(ctx: CommandContext): Promise<void> {
  const { out } = ctx;
  const { config: cfg } = ctx.configLoader.load();
  const vision = cfg.vision;
  if (!vision.enabled) {
    out.log(`${COLORS.yellow}提示: 视觉功能未启用（vision.enabled=false），本次仍按当前配置测试${COLORS.reset}`);
  }

  const targets = resolveVisionTargets(vision, cfg.model);
  if (!targets.apiKey) {
    out.blank();
    out.log(`${COLORS.red}✗ 连通性测试失败: 未配置 API Key（vision.apiKey 与主模型 model.apiKey 均为空）${COLORS.reset}`);
    out.log(`${COLORS.gray}  先执行 /config set vision.apiKey <key> 再 /vision test${COLORS.reset}`);
    out.blank();
    return;
  }

  out.blank();
  out.log(`${COLORS.gray}测试中: ${targets.model} @ ${targets.baseUrl} …${COLORS.reset}`);
  const messages: VisionMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这是一张 1x1 像素的测试图片，请用不超过 10 个字描述它。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TEST_PNG_BASE64}` } },
      ],
    },
  ];

  try {
    const result = await llm.chatVision(messages, { ...targets, maxTokens: 64 });
    out.log(`${COLORS.green}✓ 连通性测试成功${COLORS.reset} ${COLORS.gray}(${result.elapsedMs}ms${result.usage ? `, tokens ${result.usage.total_tokens}` : ''})${COLORS.reset}`);
    const reply = result.content.trim().replace(/\s+/g, ' ');
    out.log(`  ${COLORS.white}模型答复:${COLORS.reset} ${reply.length > 100 ? `${reply.slice(0, 100)}…` : reply}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out.log(`${COLORS.red}✗ 连通性测试失败:${COLORS.reset} ${msg}`);
    out.log(`${COLORS.gray}  排查: model 是否为视觉模型 / baseUrl 是否正确 / apiKey 是否有效${COLORS.reset}`);
  }
  out.blank();
}

export const visionCommand: CommandHandler = {
  name: '/vision',
  description: '视觉功能管理（status/test）',
  subcommands: ['status', 'test', 'help'],
  subcommandHelp: {
    status: '查看视觉模型配置状态',
    test: '测试视觉模型连通性',
  },
  match: (input) => /^\/vision(?:\s|$)/i.test(input.trim()),
  async execute(input, ctx) {
    const { out } = ctx;
    const parts = input.split(/\s+/);
    const sub = parts[1] ?? 'status';

    if (sub === 'status') {
      printStatus(ctx);
      return;
    }
    if (sub === 'test') {
      await runTest(ctx);
      return;
    }

    out.blank();
    out.log(`${COLORS.red}未知子命令: ${sub}${COLORS.reset}`);
    out.log(`用法: /vision status | /vision test`);
    out.blank();
  },
};
