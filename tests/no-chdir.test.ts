/**
 * A4 静态收口断言（Task-20261021-010-03 6.4.5）
 *
 * - `process.chdir` 在 src/ 下零出现（切换空间不再改变进程 cwd）
 * - `process.cwd()` 仅剩"保留"类，且逐文件白名单：应用自身资源 / CLI 单空间 / 共享默认值
 * - switchWorkspace 不再调用 rebindWorkspace / setWorkspacePath / resetMemoryKitCache
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 允许保留 process.cwd() 的文件（相对 src/，POSIX 分隔符） */
const CWD_ALLOWLIST = new Set([
  // 应用自身资源（与工作空间无关）
  'api/static.ts',          // webui 构建产物定位
  'config/loader.ts',       // .env 读取 + 构造默认
  'config/writer.ts',       // 构造默认
  // 共享默认值（CLI 单空间 = 启动目录；serve 侧被 runtime 显式覆盖）
  'session/store.ts',
  'runtime/init.ts',
  'bootstrap/doctor.ts',
  'tools/runner.ts',
  'tools/workspace-fs.ts',
  'agent/react-agent.ts',
  'api/bootstrap.ts',       // 启动目录即初始空间
  'config/mcp-manager.ts',  // MCP stdio cwd：配置值 ?? 启动目录（D19）
  // CLI 单空间红线（D11：src/cli/**、src/commands/** 零 diff，保留）
  'cli/start.ts',
  'commands/skill-command.ts',
  'commands/session-command.ts',
]);

function rel(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

/** 仅统计"代码行"里的 process.cwd()（行注释/块注释/文档注释不算） */
function hasCwdCode(file: string): boolean {
  let inBlock = false;
  for (const raw of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    if (line.includes('process.cwd()')) return true;
  }
  return false;
}

const files = walk(SRC);

describe('A4 process.chdir 零出现', () => {
  it('src/ 下不存在 process.chdir', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf-8').includes('process.chdir('));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('switchWorkspace 不再原地重绑 / 改写配置层 / 重置记忆缓存', () => {
    const text = readFileSync(join(SRC, 'api', 'handlers', 'sessions.ts'), 'utf-8');
    for (const banned of ['rebindWorkspace(', 'setWorkspacePath(', 'resetMemoryKitCache(']) {
      expect(text.includes(banned), `sessions.ts 不应再调用 ${banned}`).toBe(false);
    }
  });
});

describe('A4 process.cwd() 白名单', () => {
  it('仅保留应用自身资源 / CLI 单空间 / 共享默认值文件', () => {
    const users = files
      .filter(hasCwdCode)
      .map(rel)
      .sort();
    const unexpected = users.filter((f) => !CWD_ALLOWLIST.has(f));
    expect(unexpected).toEqual([]);
  });

  it('serve 侧空间资源文件已清零（skills 组 / memory-kit / 切换逻辑）', () => {
    for (const file of ['api/handlers/skills.ts', 'api/memory-kit.ts', 'api/handlers/sessions.ts', 'api/handlers/messages.ts']) {
      expect(hasCwdCode(join(SRC, file)), `${file} 不应再依赖进程 cwd`).toBe(false);
    }
  });
});
