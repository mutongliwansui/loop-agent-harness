// 桌面壳配置读取单测
//
// 重点覆盖 LOOP_AGENT_HOME：壳与后端必须对「用户数据目录在哪」保持同一认知，
// 否则隔离运行（自定义数据目录）时壳读到真实配置的端口/token，后端起在临时目录，
// 表现为窗口 401 或连到别的实例上。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readShellConfig,
  defaultAgentDir,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_BUDGET_MS,
} from '../desktop/src/config.js';

describe('desktop/config', () => {
  let dir: string;
  const savedHome = process.env.LOOP_AGENT_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-shell-cfg-'));
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.LOOP_AGENT_HOME;
    else process.env.LOOP_AGENT_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认数据目录遵循 LOOP_AGENT_HOME（与后端 loopAgentHome 一致）', () => {
    process.env.LOOP_AGENT_HOME = dir;
    expect(defaultAgentDir()).toBe(dir);
  });

  it('LOOP_AGENT_HOME 为空串或纯空白时回落真实用户目录', () => {
    for (const v of ['', '   ']) {
      process.env.LOOP_AGENT_HOME = v;
      expect(defaultAgentDir()).not.toBe(v);
      expect(defaultAgentDir()).toContain('.loop-agent');
    }
  });

  it('从指定目录读取 port 与 token', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ api: { port: 3311, token: 'secret-abc' } }),
      'utf-8',
    );
    expect(readShellConfig(dir)).toEqual({ port: 3311, token: 'secret-abc', shutdownBudgetMs: DEFAULT_SHUTDOWN_BUDGET_MS });
  });

  it('配置缺失时回落默认端口且无 token', () => {
    expect(readShellConfig(dir)).toEqual({ port: DEFAULT_PORT, token: '', shutdownBudgetMs: DEFAULT_SHUTDOWN_BUDGET_MS });
  });

  it('配置损坏（非法 JSON）时同样回落，不抛错', () => {
    writeFileSync(join(dir, 'config.json'), '{ not json', 'utf-8');
    expect(readShellConfig(dir)).toEqual({ port: DEFAULT_PORT, token: '', shutdownBudgetMs: DEFAULT_SHUTDOWN_BUDGET_MS });
  });

  it('端口越界或非整数时回落默认值，token 非字符串时视为空', () => {
    for (const bad of [0, 70000, 3.5, 'abc']) {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ api: { port: bad, token: 123 } }),
        'utf-8',
      );
      expect(readShellConfig(dir)).toEqual({ port: DEFAULT_PORT, token: '', shutdownBudgetMs: DEFAULT_SHUTDOWN_BUDGET_MS });
    }
  });

  it('token 两端空白被裁剪', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ api: { port: 3000, token: '  tk  ' } }),
      'utf-8',
    );
    expect(readShellConfig(dir).token).toBe('tk');
  });

  it('无 LOOP_AGENT_HOME 时默认函数指向真实 ~/.loop-agent', () => {
    delete process.env.LOOP_AGENT_HOME;
    const p = defaultAgentDir();
    expect(p.endsWith(join('', '.loop-agent'))).toBe(true);
    // 不实际读该文件，只确认路径形态
    mkdirSync(join(dir, 'x'), { recursive: true });
  });

  // 任务 20261112-007-02：壳必须读到 Dreaming 预算，关停上限 = 预算 + 宽限（D2-4）
  it('读取 memory.dreaming.shutdownBudgetMs', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ memory: { dreaming: { shutdownBudgetMs: 12_000 } } }),
      'utf-8',
    );
    expect(readShellConfig(dir).shutdownBudgetMs).toBe(12_000);
  });

  it('预算非正数/非数字时回落默认值（0 会让等待上限只剩宽限，等于直接强杀）', () => {
    for (const bad of [0, -1, 'abc', null]) {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ memory: { dreaming: { shutdownBudgetMs: bad } } }),
        'utf-8',
      );
      expect(readShellConfig(dir).shutdownBudgetMs).toBe(DEFAULT_SHUTDOWN_BUDGET_MS);
    }
  });
});
