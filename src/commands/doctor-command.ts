// /doctor 命令处理器：输出启动体检报告（逐项检测，全程只读，不修改任何文件）
import {
  checkBootstrap,
  defaultBootstrapPaths,
  type BootstrapIssueId,
} from '../bootstrap/doctor.js';
import type { AgentConfig } from '../config/schema.js';
import { COLORS } from '../ui/colors.js';
import type { CommandContext, CommandHandler } from './registry.js';

/** 检测项展示清单：id → 展示标签与修复提示（与 doctor.ts 的 BootstrapIssueId 一一对应） */
export const ITEM_LABELS: Array<{ id: BootstrapIssueId; label: string; hint: string }> = [
  { id: 'model-apiKey', label: '主模型 apiKey', hint: '运行 /setup 重新配置' },
  { id: 'model-name', label: '主模型名称', hint: '运行 /setup 重新配置' },
  { id: 'global-config', label: '全局配置文件', hint: '首次写入配置时自动创建' },
  { id: 'skills-global', label: '全局 skills 目录', hint: '下次启动时自动补建' },
];

/** 单项体检结果（CLI 展示与 GET /doctor 共用结构；detail 已并入修复提示/路径） */
export interface DoctorCheck {
  id: BootstrapIssueId;
  name: string;
  ok: boolean;
  level?: 'blocker' | 'missing';
  detail: string;
}

/** 只读体检装配（CLI /doctor 与 GET /doctor 单源共用，绝不写盘） */
export function buildDoctorChecks(cfg: AgentConfig): { ok: boolean; checks: DoctorCheck[] } {
  const report = checkBootstrap(cfg, defaultBootstrapPaths());
  const byId = new Map(report.issues.map((i) => [i.id, i]));
  const checks = ITEM_LABELS.map((item): DoctorCheck => {
    const issue = byId.get(item.id);
    if (!issue) return { id: item.id, name: item.label, ok: true, detail: '' };
    return {
      id: item.id,
      name: item.label,
      ok: false,
      level: issue.level,
      detail: issue.level === 'blocker'
        ? `${issue.message}（${item.hint}）`
        : `${issue.message}${issue.path ? ` → ${issue.path}` : ''}`,
    };
  });
  return { ok: report.ok, checks };
}

export const doctorCommand: CommandHandler = {
  name: '/doctor',
  description: '启动体检：逐项检测配置与目录状态（只读）',
  match: (input) => /^\/doctor(?:\s|$)/i.test(input.trim()),
  async execute(_input, ctx: CommandContext) {
    const { out } = ctx;
    const { config: cfg } = ctx.configLoader.load();
    // 只读检测：绝不调用 scaffold / updateScope 等任何写盘逻辑
    const { ok, checks } = buildDoctorChecks(cfg);

    out.blank();
    out.log(`${COLORS.bold}启动体检报告${COLORS.reset}`);
    out.blank();
    for (const item of checks) {
      if (item.ok) {
        out.log(`  ${COLORS.green}✓${COLORS.reset} ${item.name}`);
      } else if (item.level === 'blocker') {
        out.log(`  ${COLORS.red}✗${COLORS.reset} ${item.name}：${item.detail}`);
      } else {
        out.log(`  ${COLORS.yellow}!${COLORS.reset} ${item.name}：${item.detail}`);
      }
    }
    out.blank();
    if (ok) {
      out.log(`  ${COLORS.green}✓ 阻断项 0 个，主模型配置齐备，可正常对话${COLORS.reset}`);
    } else {
      out.log(
        `  ${COLORS.yellow}存在阻断项，请运行 ${COLORS.bold}/setup${COLORS.reset}${COLORS.yellow} 修复${COLORS.reset}`,
      );
    }
    out.log(`  ${COLORS.gray}本命令只读，不修改任何文件${COLORS.reset}`);
    out.blank();
  },
};
