// PowerShell 子进程运行时（需求 20261112-004 / 任务 01 / D7）
//
// 为什么单独抽一层：Windows 上「零新增 npm 依赖」调用 WinRT 的唯一途径是起 powershell.exe
// 子进程（OCR 引擎与 PDF 光栅化都要）。若各自复制一份 spawn/超时/截断/落盘逻辑，会立刻
// 产生两套口径（超时算法、输出截断长度、脚本命名规则），排障时无法对比。
//
// 四个共用约束（源自 20261112-002 的踩坑记录）：
//   1. 脚本必须以**纯 ASCII 无 BOM** 写入磁盘再用 `-File` 调用：走 stdin（`-Command -`）
//      会与控制台代码页纠缠，含中文的脚本在 GBK 代码页机器上会被按本地码页解读。
//   2. 目标机是 Windows PowerShell 5.1（Desktop 版），脚本内不得使用 PS7 语法。
//   3. 输出协议为逐行 `KEY=VALUE`，值一律 ASCII；结构化数据走文件回传。
//   4. spawn 用参数数组、不经 shell；超时到点 kill 进程。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** PowerShell 单次执行结果（不抛错，失败信息全部落在字段里） */
export interface PsRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
}

/** powershell.exe 路径：优先环境变量覆盖（单测/特殊部署），否则取系统目录 */
export function powershellPath(): string {
  const override = process.env.LOOP_AGENT_POWERSHELL;
  if (override && override.trim()) return override.trim();
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 同步零成本可用性判断（不 spawn）。
 * 启动阶段用它决定要不要注册依赖 WinRT 的能力，避免每次启动多 0.7s 进程开销。
 * 注意：只判断「powershell.exe 存在」，不代表 WinRT 组件齐全（那要 spawn 探测）。
 */
export function powershellLikelyAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  return existsSync(powershellPath());
}

/** 脚本落盘目录（与 OCR/光栅化共用，便于排查时一眼看到所有已落地脚本） */
const SCRIPT_DIR = 'loop-agent-ps';

/** 同内容同前缀只写一次（进程内缓存；key = prefix + 内容 sha1） */
const scriptFiles = new Map<string, Promise<string>>();

/**
 * 把脚本内容按内容哈希落盘，返回绝对路径。
 *
 * - 文件名 `<prefix>-<sha1_12>.ps1`，内容不变则复用同一文件（多次调用零 IO）；
 * - 写入编码固定 utf8 且脚本本身必须纯 ASCII，等价于「无 BOM 的 ASCII 文件」。
 */
export function ensureScriptFile(content: string, prefix: string): Promise<string> {
  const stamp = createHash('sha1').update(content).digest('hex').slice(0, 12);
  const key = `${prefix}:${stamp}`;
  const cached = scriptFiles.get(key);
  if (cached) return cached;
  const task = (async (): Promise<string> => {
    const dir = join(tmpdir(), SCRIPT_DIR);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${prefix}-${stamp}.ps1`);
    if (!existsSync(file)) {
      await writeFile(file, content, 'utf8');
    }
    return file;
  })();
  scriptFiles.set(key, task);
  return task;
}

/** 测试钩子：清空脚本落盘缓存（不改文件，只让下次重新计算路径） */
export function resetScriptFileCache(): void {
  scriptFiles.clear();
}

/**
 * spawn powershell.exe 执行脚本。
 * 超时到点 kill（不 kill 进程树：脚本自身无子进程）；stdout 上限 64KB、stderr 上限 8KB。
 */
export function runPowerShell(args: string[], timeoutMs: number): Promise<PsRunResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const child = spawn(powershellPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
    }, Math.max(1000, timeoutMs));

    child.stdout?.on('data', (chunk: Buffer) => {
      // 输出协议很小（状态行），超过 64KB 视为异常直接丢弃尾部
      if (stdoutBytes < 64 * 1024) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < 8 * 1024) {
        stderr.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        timedOut,
        spawnError,
      });
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}

/** 解析脚本的 KEY=VALUE 输出（键须匹配 /^[A-Z][A-Z0-9_]*$/） */
export function parsePsOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    // key 允许含数字：ERROR_MSG_B64 这类带版本/进制后缀的键曾因 /^[A-Z_]+$/ 被静默丢弃，
    // 导致 decode_failed 的原始异常信息永远透不出来，只剩一句固定文案。
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

/** UTF-8 base64 → 文本（脚本用它回传含中文的错误说明，绕开控制台代码页） */
export function decodeBase64Text(b64: string | undefined): string | null {
  if (!b64) return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** 从脚本输出里取第一条 `[FAIL] ...` 行（脚本失败时的统一回传格式） */
export function firstFailLine(stdout: string, stderr: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[FAIL]')) return t.slice('[FAIL]'.length).trim() || t;
  }
  const err = stderr.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '');
  return err ?? null;
}
