// 初次启动配置向导：分步收集主模型三元组（baseUrl/apiKey/name）并校验连通性
// 交互函数通过 deps 注入，单测可模拟输入序列；默认实现基于 readline 与 openai SDK
import readline from 'node:readline';
import { configWriter } from '../config/index.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../config/schema.js';
import {
  defaultCheckConnectivity,
  type CheckConnectivityFn,
  type ConnectivityResult,
  type ModelCandidate,
} from '../llm/connectivity.js';
import { COLORS as C } from '../ui/colors.js';
import { Spinner } from '../ui/spinner.js';
import { defaultBootstrapPaths } from './doctor.js';
import type { BootstrapReport } from './doctor.js';
import { backupCorruptedFile, ensureScaffold } from './scaffold.js';

// 连通性校验已抽到 llm/connectivity.ts 共享（/model 命令复用）；此处原样 re-export 保持既有 API
export { defaultCheckConnectivity } from '../llm/connectivity.js';
export type { ModelCandidate, ConnectivityResult, CheckConnectivityFn } from '../llm/connectivity.js';

export type AskFn = (prompt: string) => Promise<string>;

/** 写入候选三元组，返回实际写入的配置文件路径（需求 20261112-008：只有全局一份配置） */
export type WriteConfigFn = (candidate: ModelCandidate) => Promise<string>;

/** 登记 profile（Task-20261011-002 P1 向导联动；默认 configWriter.update 写 default） */
export type RegisterProfileFn = (alias: string, candidate: ModelCandidate) => Promise<void>;

export type ScaffoldFn = () => Promise<string[]>;

export type OutFn = (line?: string) => void;

export interface WizardDeps {
  /** 提问函数（默认 readline）；提供后 askSecret 默认回退到它（明文） */
  ask?: AskFn;
  /** 密钥提问函数（默认遮蔽回显；deps.ask 存在时回退到 ask） */
  askSecret?: AskFn;
  /** 复用外部 readline（/setup 在 REPL 内重跑时注入，避免第二个接口抢占 stdin） */
  rl?: readline.Interface;
  /** 用户偏好（/setup --global）；设置时写入确认的默认项取该值。--workspace 已移除 */
  preferredScope?: 'global';
  /** 连通性校验（默认 openai SDK 直接 ping 候选三元组） */
  checkConnectivity?: CheckConnectivityFn;
  /** 配置写盘（默认 configWriter.update 写全局） */
  writeConfig?: WriteConfigFn;
  /** profile 登记（默认 configWriter.update 写 models.active + profiles；注入用于单测断言） */
  registerProfile?: RegisterProfileFn;
  /** 目录补建（默认 ensureScaffold） */
  scaffold?: ScaffoldFn;
  /** 输出通道（默认 console.log，便于单测收集） */
  out?: OutFn;
  /** 向导结束后的清理（默认关闭自建的 readline；注入 rl 时绝不关闭外部接口） */
  close?: () => void;
}

/** 自建 readline（首次启动场景）；Ctrl+C 打印未完成提示后退出 */
function createOwnRl(): readline.Interface {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    process.stdout.write('初始化未完成，已输入内容未保存。下次启动将重新引导。\n');
    process.exit(1);
  });
  return rl;
}

/** 复用外部 readline 提问（/setup 场景；SIGINT 由 REPL 统一处理，此处不挂监听） */
function askFromRl(rl: readline.Interface): AskFn {
  return (prompt) =>
    new Promise<string>((resolve) => {
      rl.question(prompt, resolve);
    });
}

/**
 * 整行遮蔽：可见字符替换为 *；保留控制字符（退格 \b、回车 \r 等）与 ANSI 转义序列
 * （readline 重绘依赖这些序列，保留后星号数与当前已输入内容自动同步）
 */
function maskLine(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '\x1b') {
      // 保留完整 CSI 转义序列：ESC [ ... 直至最终字节（@-~）
      let j = i + 1;
      if (s.charAt(j) === '[') {
        j++;
        while (j < s.length && !/[@-~]/.test(s.charAt(j))) j++;
        if (j < s.length) j++;
      }
      out += s.slice(i, j);
      i = j - 1;
      continue;
    }
    const code = s.charCodeAt(i);
    out += code < 32 || code === 127 ? ch : '*';
  }
  return out;
}

/**
 * 遮蔽回显的输出过滤器（纯函数，便于单测）。
 * readline 的重绘 chunk 可能包含 prompt：此时视为整行刷新——prompt 原样保留，
 * 其余可见字符遮蔽；不含 prompt 的 chunk（增量回显、退格序列等）整段遮蔽
 * （控制字符与转义序列除外）。
 */
export function maskEchoChunk(prompt: string, chunk: string): string {
  const idx = chunk.indexOf(prompt);
  if (idx < 0) return maskLine(chunk);
  return maskLine(chunk.slice(0, idx)) + prompt + maskLine(chunk.slice(idx + prompt.length));
}

/**
 * 密钥提问：覆盖 rl 的 _writeToOutput 拦截回显，输入以 * 显示且支持退格。
 * readline 无原生密码模式，_writeToOutput 是其约定的自定义回显挂点。
 */
export function createMaskedAsk(rl: readline.Interface): AskFn {
  const target = rl as unknown as {
    _writeToOutput?: (chunk: string) => void;
    output: { write: (chunk: string) => void };
  };
  return (prompt) =>
    new Promise<string>((resolve) => {
      const original = target._writeToOutput;
      target._writeToOutput = (chunk: string) => {
        target.output.write(maskEchoChunk(prompt, chunk));
      };
      rl.question(prompt, (answer) => {
        if (original) target._writeToOutput = original;
        else delete target._writeToOutput;
        resolve(answer);
      });
    });
}

const defaultWriteConfig: WriteConfigFn = async (candidate) => {
  await configWriter.update({
    model: { baseUrl: candidate.baseUrl, apiKey: candidate.apiKey, name: candidate.name },
  });
  return configWriter.globalConfigPath;
};

/** 向导联动（Task-20261011-002 P1 5.6）：登记 profile（写激活指针 + 登记簿） */
const defaultRegisterProfile: RegisterProfileFn = async (alias, candidate) => {
  await configWriter.update({
    models: { active: alias, profiles: { [alias]: candidate } },
  });
};

const defaultScaffold: ScaffoldFn = async () => {
  const { created } = await ensureScaffold(defaultBootstrapPaths());
  return created;
};

function maskKey(key: string): string {
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

function printIssues(report: BootstrapReport, out: OutFn): void {
  for (const issue of report.issues) {
    const mark = issue.level === 'blocker' ? `${C.red}✗${C.reset}` : `${C.yellow}!${C.reset}`;
    out(`  ${mark} ${issue.message}${issue.path ? `（${issue.path}）` : ''}`);
  }
}

/** 分步收集三元组（baseUrl → apiKey → name）；apiKey 走 askSecret（遮蔽回显） */
async function collectInput(
  ask: AskFn,
  askSecret: AskFn,
  out: OutFn,
  cfg: AgentConfig,
): Promise<ModelCandidate> {
  const defaultBaseUrl = cfg.model.baseUrl || DEFAULT_CONFIG.model.baseUrl;
  const baseUrl = (await ask(`模型服务地址 [${defaultBaseUrl}]: `)).trim() || defaultBaseUrl;

  let apiKey = '';
  while (apiKey === '') {
    apiKey = (await askSecret('模型 apiKey（必填，输入以 * 遮蔽）: ')).trim();
    if (apiKey === '') out(`${C.yellow}apiKey 不能为空，请重新输入。${C.reset}`);
  }

  const defaultModel = cfg.model.name || DEFAULT_CONFIG.model.name;
  let name = '';
  while (name === '') {
    name =
      (await ask(`模型名称（必填，如 deepseek-chat / gpt-4o-mini）[${defaultModel}]: `)).trim() ||
      defaultModel;
    if (name === '') out(`${C.yellow}模型名称不能为空，请重新输入。${C.reset}`);
  }

  return { baseUrl, apiKey, name };
}

/** 带动画的连通性校验；结果文案统一走 out（Spinner 非启用时静默） */
async function runCheck(
  candidate: ModelCandidate,
  checkConnectivity: CheckConnectivityFn,
  out: OutFn,
): Promise<ConnectivityResult> {
  const spinner = new Spinner();
  spinner.start('正在验证模型连通性…');
  const result = await checkConnectivity(candidate);
  spinner.stop();
  if (result.ok) {
    out(`${C.green}✓ 连接成功（模型 ${candidate.name}，${result.elapsedMs ?? 0} ms）${C.reset}`);
  } else {
    out(`${C.red}✗ 连接失败：${result.error ?? '未知错误'}${C.reset}`);
  }
  return result;
}

/**
 * 初次启动配置向导（Task-20261011-001 3.3）
 *
 * 流程：欢迎+缺失清单 → baseUrl → apiKey → name → 连通性校验（重试/重新输入/仍保存）
 *      → 写入层确认 → scaffold + 写盘 → 摘要
 */
export async function runWizard(
  report: BootstrapReport,
  cfg: AgentConfig,
  deps: WizardDeps = {},
): Promise<void> {
  const out: OutFn = deps.out ?? ((line = '') => console.log(line));

  // 提问通道优先级：deps.ask/askSecret（单测注入）→ deps.rl（REPL 复用）→ 自建 readline
  let ask: AskFn;
  let askSecret: AskFn;
  let ownRl: readline.Interface | null = null;
  if (deps.ask) {
    ask = deps.ask;
    askSecret = deps.askSecret ?? deps.ask;
  } else if (deps.rl) {
    ask = askFromRl(deps.rl);
    askSecret = deps.askSecret ?? createMaskedAsk(deps.rl);
  } else {
    ownRl = createOwnRl();
    ask = askFromRl(ownRl);
    askSecret = deps.askSecret ?? createMaskedAsk(ownRl);
  }

  const checkConnectivity = deps.checkConnectivity ?? defaultCheckConnectivity;
  const writeConfig = deps.writeConfig ?? defaultWriteConfig;
  const registerProfile = deps.registerProfile ?? defaultRegisterProfile;
  const scaffold = deps.scaffold ?? defaultScaffold;

  // 1. 欢迎语 + 缺失项清单
  out('');
  out(`${C.cyan}${C.bold}欢迎使用 Loop Agent！检测到首次运行或配置缺失，开始初始化向导。${C.reset}`);
  out('');
  printIssues(report, out);
  out('');

  try {
    // 2-4. 分步收集三元组
    let candidate = await collectInput(ask, askSecret, out, cfg);

    // 5. 连通性校验（失败三选项：重试 / 重新输入 / 仍保存并标注未验证）
    let check = await runCheck(candidate, checkConnectivity, out);
    while (!check.ok) {
      const choice = (
        await ask('请选择：[r] 重试 / [e] 重新输入 / [s] 仍保存（将标注未验证）: ')
      ).trim().toLowerCase();
      if (choice === 'r') {
        check = await runCheck(candidate, checkConnectivity, out);
      } else if (choice === 'e') {
        candidate = await collectInput(ask, askSecret, out, cfg);
        check = await runCheck(candidate, checkConnectivity, out);
      } else {
        break;
      }
    }

    // 6. 写入位置（需求 20261112-008：配置只有全局一份，不再询问写入层）
    // 7. 目录补建 + 写盘（默认写盘路径下：目标文件若为损坏 JSON，先自动备份为 .bak-<时间戳>）
    const created = await scaffold();
    for (const p of created) out(`${C.green}✓ 已创建: ${p}${C.reset}`);
    if (!deps.writeConfig) {
      const backupPath = await backupCorruptedFile(configWriter.globalConfigPath);
      if (backupPath) {
        out(`${C.yellow}⚠ 原配置文件已损坏，已自动备份为: ${backupPath}${C.reset}`);
      }
    }
    const writtenPath = await writeConfig(candidate);

    // 向导联动（Task-20261011-002 P1 5.6）：登记簿为空时将本次模型登记为 profile default（失败不阻断）
    if (Object.keys(cfg.models.profiles).length === 0) {
      try {
        await registerProfile('default', candidate);
        out(`  已登记：profile default（/model add 接入更多模型后 /model use 切换）`);
      } catch {
        out(
          `  ${C.yellow}⚠ profile 登记失败，不影响基本使用，可稍后手动执行 /model add default${C.reset}`,
        );
      }
    }

    // 8. 摘要（apiKey 只显示尾 4 位）
    out('');
    out(`${C.cyan}${C.bold}初始化完成${C.reset}`);
    out(`  写入位置：全局（${writtenPath}）`);
    out(`  服务地址：${candidate.baseUrl}`);
    out(`  模型名称：${candidate.name}`);
    out(`  apiKey：${maskKey(candidate.apiKey)}`);
    out(`  连通性：${check.ok ? `${C.green}已验证${C.reset}` : `${C.yellow}⚠ 未验证${C.reset}`}`);
    out('');
  } finally {
    if (deps.close) deps.close();
    else if (ownRl) ownRl.close();
  }
}
