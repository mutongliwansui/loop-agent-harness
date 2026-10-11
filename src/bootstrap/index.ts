// 初次启动引导入口：检测 → 分流（向导 / 静默补建 / 直接通过）
// 挂接点：main() 配置加载之前；引导写盘后由调用方重新 configLoader.load() 刷新生效值
import { configLoader } from '../config/index.js';
import { COLORS as C } from '../ui/colors.js';
import { checkBootstrap, defaultBootstrapPaths } from './doctor.js';
import type { BootstrapIssue, BootstrapPaths } from './doctor.js';
import { ensureScaffold } from './scaffold.js';
import { runWizard } from './wizard.js';

export { checkBootstrap, defaultBootstrapPaths } from './doctor.js';
export type {
  BootstrapIssue,
  BootstrapIssueId,
  BootstrapReport,
  BootstrapPaths,
} from './doctor.js';
export { ensureDirs, ensureConfigFiles, ensureScaffold } from './scaffold.js';
export { runWizard, defaultCheckConnectivity } from './wizard.js';
export type {
  ModelCandidate,
  WizardDeps,
  ConnectivityResult,
} from './wizard.js';

export interface EnsureBootstrapOptions {
  /** 跳过全部检测与引导（--no-setup） */
  noSetup?: boolean;
}

/**
 * 启动引导总入口（Task-20261011-001 3.4）
 *
 * 分流规则（D2 两级）：
 * - 完全齐备 → 直接返回，零打扰
 * - 有 blocker（主模型三元组缺失）→ 非 TTY 打印手动指引，否则进向导
 * - 仅 missing（目录/文件缺失）→ 静默幂等补建并逐项打印 ✓
 * - 非 TTY 一律不进向导（D6）
 */
export async function ensureBootstrap(opts: EnsureBootstrapOptions = {}): Promise<void> {
  if (opts.noSetup) return;

  const paths = defaultBootstrapPaths();
  const { config: cfg } = configLoader.load();
  const report = checkBootstrap(cfg, paths);
  if (report.issues.length === 0) return;

  const blockers = report.issues.filter((i) => i.level === 'blocker');
  const missing = report.issues.filter((i) => i.level === 'missing');

  // 非 TTY（管道/CI）：不进向导，仅补建 + 手动配置指引
  if (process.stdin.isTTY !== true) {
    if (blockers.length > 0) printManualGuide(blockers);
    await applyScaffold(missing, paths);
    return;
  }

  if (blockers.length > 0) {
    await runWizard(report, cfg);
    return;
  }

  await applyScaffold(missing, paths);
}

async function applyScaffold(missing: BootstrapIssue[], paths: BootstrapPaths): Promise<void> {
  if (missing.length === 0) return;
  const { created } = await ensureScaffold(paths);
  for (const p of created) {
    console.log(`${C.green}✓ 已创建: ${p}${C.reset}`);
  }
}

/** 非 TTY 时的手动配置指引（D6：两条路径） */
function printManualGuide(blockers: BootstrapIssue[]): void {
  console.log(
    `${C.yellow}⚠ 检测到主模型配置缺失，且当前非交互终端，无法进入配置向导：${C.reset}`,
  );
  for (const b of blockers) {
    console.log(`  ✗ ${b.message}`);
  }
  console.log('');
  console.log('请通过以下任一方式完成配置：');
  console.log(
    `  1. 在交互终端运行 Agent 完成初始化向导，或在 REPL 中执行 ${C.cyan}/config set model.apiKey <你的密钥>${C.reset}`,
  );
  console.log(
    `  2. 设置环境变量 ${C.cyan}OPENAI_API_KEY${C.reset}（可选 ${C.cyan}MODEL_NAME${C.reset}、${C.cyan}OPENAI_BASE_URL${C.reset}）后重新启动`,
  );
}
